import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { fakePg, fakeRedis, authHeader } from './helpers.js';

// A minimal Response-like stub: openaiCompatible reads .status and .text().
function fakeResponse(status, payload) {
  return {
    status,
    text: async () =>
      typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

// A web ReadableStream of SSE chunks, like undici's response.body.
function sseStream(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const upstreamSuccess = {
  id: 'chatcmpl-123',
  object: 'chat.completion',
  model: 'llama-3.1-8b-instant',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi there' } }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

describe('POST /v1/chat/completions', () => {
  let app;
  let fetchMock;

  beforeEach(async () => {
    const config = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      GROQ_API_KEY: 'gsk_test_key',
    });
    // why: inject fake pg/redis so auth + rate-limit pass without real infra.
    app = buildApp(config, { pg: fakePg(), redis: fakeRedis() });
    await app.ready();

    // why: stub the network so tests never hit a real provider.
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it('forwards a valid request to the provider and returns the response', async () => {
    fetchMock.mockResolvedValue(fakeResponse(200, upstreamSuccess));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeader(),
      payload: {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.5,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(upstreamSuccess);

    // forwarded to the right upstream with the bearer key + JSON body
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(opts.method).toBe('POST');
    expect(opts.headers.authorization).toBe('Bearer gsk_test_key');
    expect(JSON.parse(opts.body).model).toBe('llama-3.1-8b-instant');
  });

  it('passes the upstream error status and body straight through', async () => {
    const upstreamError = {
      error: { message: 'model not found', type: 'invalid_request_error' },
    };
    fetchMock.mockResolvedValue(fakeResponse(404, upstreamError));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeader(),
      payload: {
        model: 'nope',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(upstreamError);
  });

  it('rejects an invalid body with 400 and does not call upstream', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeader(),
      payload: { model: 'llama-3.1-8b-instant' }, // missing messages
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('invalid_request_error');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('streams upstream SSE chunks to the client when stream:true', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: sseStream(chunks),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeader(),
      payload: {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // the SSE bytes were passed through untouched, including the [DONE] sentinel
    expect(res.payload).toContain('Hel');
    expect(res.payload).toContain('lo');
    expect(res.payload).toContain('[DONE]');

    // upstream was asked to stream
    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body).stream).toBe(true);
    expect(opts.headers.accept).toBe('text/event-stream');
  });

  it('forwards an upstream error as JSON (not SSE) for a streaming request', async () => {
    const upstreamError = {
      error: { message: 'invalid api key', type: 'authentication_error' },
    };
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify(upstreamError),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeader(),
      payload: {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual(upstreamError);
  });

  it('returns 502 when the upstream call throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeader(),
      payload: {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error.type).toBe('upstream_error');
  });

  it('returns 503 when no provider is configured', async () => {
    // rebuild app without a provider key
    await app.close();
    const config = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    app = buildApp(config, { pg: fakePg(), redis: fakeRedis() });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeader(),
      payload: {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.type).toBe('no_provider');
  });
});
