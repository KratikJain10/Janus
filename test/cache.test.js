import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { fakePg, fakeRedis, authHeader, chatPayload } from './helpers.js';

const upstreamSuccess = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }],
};

describe('exact-match cache (chat route)', () => {
  let app;
  let fetchMock;

  beforeEach(async () => {
    const config = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      GROQ_API_KEY: 'gsk_test',
    });
    // why: a single fakeRedis instance persists its store across requests so a
    // write on the first request is visible to the second.
    app = buildApp(config, { pg: fakePg(), redis: fakeRedis() });
    await app.ready();

    fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify(upstreamSuccess),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  const post = (payload) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeader(),
      payload,
    });

  it('MISS then HIT: second identical request is served from cache', async () => {
    const first = await post(chatPayload());
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-cache']).toBe('MISS');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await post(chatPayload());
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.json()).toEqual(upstreamSuccess);
    // why: the cached hit must NOT hit the upstream again.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('different params produce a cache miss (no false hit)', async () => {
    await post(chatPayload());
    const other = await post({ ...chatPayload(), temperature: 0.9 });
    expect(other.headers['x-cache']).toBe('MISS');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache error responses', async () => {
    fetchMock.mockResolvedValue({
      status: 429,
      text: async () => JSON.stringify({ error: { message: 'slow down' } }),
    });

    const first = await post(chatPayload());
    expect(first.statusCode).toBe(429);
    expect(first.headers['x-cache']).toBe('MISS');

    const second = await post(chatPayload());
    // why: errors aren't cached, so the second request retries the upstream.
    expect(second.headers['x-cache']).toBe('MISS');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache streaming responses', async () => {
    const stream = (chunks) => {
      const enc = new TextEncoder();
      return new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(enc.encode(ch));
          c.close();
        },
      });
    };
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      body: stream([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    }));

    const payload = { ...chatPayload(), stream: true };
    const first = await post(payload);
    const second = await post(payload);

    expect(first.headers['x-cache']).toBeUndefined();
    expect(second.headers['x-cache']).toBeUndefined();
    // why: each streaming request hits the upstream — nothing is cached.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bypasses the cache when CACHE_ENABLED=false', async () => {
    await app.close();
    const config = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      GROQ_API_KEY: 'gsk_test',
      CACHE_ENABLED: 'false',
    });
    app = buildApp(config, { pg: fakePg(), redis: fakeRedis() });
    await app.ready();

    const first = await post(chatPayload());
    const second = await post(chatPayload());
    expect(first.headers['x-cache']).toBeUndefined();
    expect(second.headers['x-cache']).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
