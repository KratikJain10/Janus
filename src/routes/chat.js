import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { getProviderChain, executeWithFallback } from '../providers/router.js';
import {
  chatCompletion,
  chatCompletionStream,
} from '../providers/openaiCompatible.js';
import {
  cacheKey,
  getCachedResponse,
  setCachedResponse,
} from '../cache/exactCache.js';
import { computeCost } from '../usage/cost.js';
import { logUsage, extractTokens } from '../usage/logger.js';
import { metrics } from '../lib/metrics.js';

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

      const providers = getProviderChain(fastify.config);
      if (providers.length === 0) {
        return reply.status(503).send({
          error: {
            type: 'no_provider',
            message: 'no upstream provider configured',
          },
        });
      }

      if (body.stream) {
        // why: streaming responses are never cached (can't buffer them, and
        // the cache stores whole JSON bodies).
        return streamCompletion(fastify, request, reply, providers, body);
      }

      return jsonCompletion(fastify, request, reply, providers, body);
    },
  );
}

// Build the retry + circuit-breaker options shared by both paths from config.
function reliabilityOpts(fastify, request) {
  const c = fastify.config;
  return {
    retry: {
      timeoutMs: c.UPSTREAM_TIMEOUT_MS,
      retries: c.UPSTREAM_MAX_RETRIES,
      log: request.log,
    },
    fallback: {
      failureThreshold: c.CIRCUIT_BREAKER_THRESHOLD,
      cooldownMs: c.CIRCUIT_BREAKER_COOLDOWN_MS,
      log: request.log,
    },
  };
}

/** Non-streaming path: serve from cache, else forward (with fallback) and cache. */
async function jsonCompletion(fastify, request, reply, providers, body) {
  const { CACHE_ENABLED, CACHE_TTL_SECONDS } = fastify.config;
  // why: namespace the cache by the primary provider; lookup happens before we
  // know which provider will actually serve.
  const primary = providers[0];
  const key = CACHE_ENABLED ? cacheKey(body, primary.name) : null;

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
      const tokens = extractTokens(cached);
      // why: a cache hit still consumed tokens originally — record it so usage
      // and cost reflect what the client received (cached = true).
      request.usage = {
        provider: primary.name,
        model: body.model,
        ...tokens,
        cost: computeCost(body.model, tokens.tokensIn, tokens.tokensOut),
        cached: true,
        status: 200,
      };
      request.log.info(
        { provider: primary.name, model: body.model, cache: 'HIT' },
        'chat completion (cache hit)',
      );
      return reply.status(200).send(cached);
    }
  }

  const { retry, fallback } = reliabilityOpts(fastify, request);
  const startedAt = Date.now();

  let served;
  let result;
  try {
    // why: try providers in order, each with its own retries; fall back on a
    // thrown error or a 5xx that exhausted retries.
    ({ provider: served, result } = await executeWithFallback(
      providers,
      (provider) => chatCompletion(provider, body, retry),
      { ...fallback, isFailure: (r) => r.status >= 500 },
    ));
  } catch (err) {
    const allOpen = err.code === 'all_providers_unavailable';
    request.log.error({ err }, 'all upstream providers failed');
    return reply.status(allOpen ? 503 : 502).send({
      error: {
        type: 'upstream_error',
        message: allOpen
          ? 'all upstream providers are temporarily unavailable'
          : 'failed to reach any upstream provider',
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
  reply.header('x-provider', served.name);

  // why: usage is recorded ONCE here, attributed to the provider that actually
  // served — retries and fallback below this line don't double-count.
  const tokens = extractTokens(result.data);
  request.usage = {
    provider: served.name,
    model: body.model,
    ...tokens,
    cost: computeCost(body.model, tokens.tokensIn, tokens.tokensOut),
    cached: false,
    status: result.status,
  };

  request.log.info(
    {
      provider: served.name,
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
async function streamCompletion(fastify, request, reply, providers, body) {
  // why: if the client goes away, abort the upstream fetch so we stop pulling
  // (and paying for) tokens nobody is reading. Listen on the RESPONSE socket
  // (reply.raw), not request.raw — request 'close' fires as soon as the request
  // body is received, which would abort us before streaming even begins.
  const controller = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) controller.abort();
  });

  const { retry, fallback } = reliabilityOpts(fastify, request);

  let provider;
  let upstream;
  try {
    // why: retries/fallback apply to ESTABLISHING the stream (before any bytes);
    // once headers arrive the body streams untouched — you can't retry mid-SSE.
    ({ provider, result: upstream } = await executeWithFallback(
      providers,
      (p) =>
        chatCompletionStream(p, body, { ...retry, signal: controller.signal }),
      {
        ...fallback,
        signal: controller.signal,
        isFailure: (res) => !res.ok && res.status >= 500,
      },
    ));
  } catch (err) {
    if (controller.signal.aborted) return; // client already disconnected
    const allOpen = err.code === 'all_providers_unavailable';
    request.log.error({ err }, 'all upstream providers failed (stream)');
    return reply.status(allOpen ? 503 : 502).send({
      error: {
        type: 'upstream_error',
        message: allOpen
          ? 'all upstream providers are temporarily unavailable'
          : 'failed to reach any upstream provider',
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
    reply.header('x-provider', provider.name);
    return reply.status(upstream.status).send(data);
  }

  // why: take over the raw socket so Fastify doesn't also try to send a reply.
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // disable proxy buffering (e.g. nginx)
    'x-provider': provider.name,
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
    const latencyMs = Date.now() - startedAt;
    // why: hijacked responses skip the global onResponse hook, so record
    // metrics + usage here. Token counts aren't parsed from the SSE stream, so
    // they (and cost) are null — we still capture request count and latency.
    metrics.recordRequest({
      route: '/v1/chat/completions',
      status: 200,
      latencyMs,
    });
    if (request.apiKey) {
      logUsage(fastify.pg, {
        apiKeyId: request.apiKey.id,
        provider: provider.name,
        model: body.model,
        tokensIn: null,
        tokensOut: null,
        totalTokens: null,
        latencyMs: Math.round(latencyMs),
        cost: null,
        cached: false,
        status: 200,
      }).catch((err) =>
        request.log.error({ err }, 'failed to persist stream usage'),
      );
    }
    request.log.info(
      {
        provider: provider.name,
        model: body.model,
        latencyMs,
        stream: true,
        aborted: controller.signal.aborted,
      },
      'chat completion (stream)',
    );
  }
}
