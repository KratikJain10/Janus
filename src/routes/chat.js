import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { getDefaultProvider } from '../config/providers.js';
import {
  chatCompletion,
  chatCompletionStream,
} from '../providers/openaiCompatible.js';
import {
  cacheKey,
  getCachedResponse,
  setCachedResponse,
} from '../cache/exactCache.js';

// why: validate the fields the gateway reasons about, but .passthrough() so any
// other OpenAI parameter (stop, presence_penalty, tools, ...) forwards intact.
const messageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z
      .union([z.string(), z.array(z.any())])
      .nullable()
      .optional(),
    name: z.string().optional(),
  })
  .passthrough();

const chatCompletionSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
  })
  .passthrough();

export default async function chatRoutes(fastify) {
  fastify.post(
    '/v1/chat/completions',
    // why: authenticate first (sets request.apiKey), then rate-limit per key.
    { preHandler: [fastify.authenticate, fastify.rateLimit] },
    async (request, reply) => {
      const parsed = chatCompletionSchema.safeParse(request.body);
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
          .join('; ');
        return reply
          .status(400)
          .send({ error: { type: 'invalid_request_error', message } });
      }
      const body = parsed.data;

      const provider = getDefaultProvider(fastify.config);
      if (!provider) {
        return reply.status(503).send({
          error: {
            type: 'no_provider',
            message: 'no upstream provider configured',
          },
        });
      }

      if (body.stream) {
        // why: streaming responses are never cached (can't buffer them, and
        // the cache stores whole JSON bodies). Phase 2 path, untouched.
        return streamCompletion(request, reply, provider, body);
      }

      return jsonCompletion(fastify, request, reply, provider, body);
    },
  );
}

/** Non-streaming path: serve from cache, else forward and cache the result. */
async function jsonCompletion(fastify, request, reply, provider, body) {
  const { CACHE_ENABLED, CACHE_TTL_SECONDS } = fastify.config;
  const key = CACHE_ENABLED ? cacheKey(body, provider.name) : null;

  if (key) {
    let cached = null;
    try {
      cached = await getCachedResponse(fastify.redis, key);
    } catch (err) {
      // why: a cache read failure must never break the request — fall through.
      request.log.warn({ err }, 'cache read failed');
    }
    if (cached) {
      reply.header('x-cache', 'HIT');
      request.log.info(
        { provider: provider.name, model: body.model, cache: 'HIT' },
        'chat completion (cache hit)',
      );
      return reply.status(200).send(cached);
    }
  }

  const startedAt = Date.now();
  let result;
  try {
    result = await chatCompletion(provider, body);
  } catch (err) {
    // why: network/connection failures — retry & fallback come in Phase 5.
    request.log.error(
      { err, provider: provider.name },
      'upstream request failed',
    );
    return reply.status(502).send({
      error: {
        type: 'upstream_error',
        message: 'failed to reach upstream provider',
      },
    });
  }

  // why: only cache successful responses — never cache errors.
  if (key && result.status === 200) {
    try {
      await setCachedResponse(
        fastify.redis,
        key,
        result.data,
        CACHE_TTL_SECONDS,
      );
    } catch (err) {
      request.log.warn({ err }, 'cache write failed');
    }
  }

  if (key) reply.header('x-cache', 'MISS');

  request.log.info(
    {
      provider: provider.name,
      model: body.model,
      upstreamStatus: result.status,
      latencyMs: Date.now() - startedAt,
      cache: key ? 'MISS' : 'BYPASS',
    },
    'chat completion',
  );

  // why: pass the upstream status + body straight through (gateway transparency).
  return reply.status(result.status).send(result.data);
}

/** Streaming path: pipe the upstream SSE bytes to the client over reply.raw. */
async function streamCompletion(request, reply, provider, body) {
  // why: if the client goes away, abort the upstream fetch so we stop pulling
  // (and paying for) tokens nobody is reading. Listen on the RESPONSE socket
  // (reply.raw), not request.raw — request 'close' fires as soon as the request
  // body is received, which would abort us before streaming even begins.
  const controller = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) controller.abort();
  });

  let upstream;
  try {
    upstream = await chatCompletionStream(provider, body, {
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) return; // client already disconnected
    request.log.error(
      { err, provider: provider.name },
      'upstream stream failed',
    );
    return reply.status(502).send({
      error: {
        type: 'upstream_error',
        message: 'failed to reach upstream provider',
      },
    });
  }

  // why: an upstream error arrives as a JSON body, not SSE — forward it as a
  // normal JSON error before we switch the response into stream mode.
  if (!upstream.ok) {
    const text = await upstream.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: { type: 'upstream_error', message: text.slice(0, 500) } };
    }
    return reply.status(upstream.status).send(data);
  }

  // why: take over the raw socket so Fastify doesn't also try to send a reply.
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // disable proxy buffering (e.g. nginx)
  });
  // why: flush headers immediately so the client sees the stream open before
  // the first token arrives.
  reply.raw.flushHeaders?.();

  const startedAt = Date.now();
  try {
    // why: pipeline streams chunks through with backpressure and no buffering,
    // and ends reply.raw when the upstream completes.
    await pipeline(Readable.fromWeb(upstream.body), reply.raw);
  } catch (err) {
    // why: a client disconnect mid-stream is expected, not an error to alarm on.
    if (!controller.signal.aborted) {
      request.log.error({ err, provider: provider.name }, 'stream interrupted');
    }
    if (!reply.raw.writableEnded) reply.raw.end();
  } finally {
    request.log.info(
      {
        provider: provider.name,
        model: body.model,
        latencyMs: Date.now() - startedAt,
        stream: true,
        aborted: controller.signal.aborted,
      },
      'chat completion (stream)',
    );
  }
}
