import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { consumeToken } from '../src/ratelimit/tokenBucket.js';
import { fakePg, fakeRedis, authHeader, chatPayload } from './helpers.js';

const config = () =>
  loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent', GROQ_API_KEY: 'gsk_test' });

describe('rate limit preHandler', () => {
  let app;
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (app) await app.close();
  });

  it('forwards and sets rate-limit headers when under the limit', async () => {
    app = buildApp(config(), { pg: fakePg(), redis: fakeRedis([1, 42, 0]) });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeader(),
      payload: chatPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('60');
    expect(res.headers['x-ratelimit-remaining']).toBe('42');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns 429 with the standard error shape when exceeded', async () => {
    app = buildApp(config(), { pg: fakePg(), redis: fakeRedis([0, 0, 30]) });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeader(),
      payload: chatPayload(),
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error.type).toBe('rate_limit_exceeded');
    expect(res.headers['retry-after']).toBe('30');
    // why: a throttled request must never reach the upstream provider.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails open if Redis errors (allows the request)', async () => {
    const brokenRedis = {
      eval: vi.fn().mockRejectedValue(new Error('redis down')),
    };
    app = buildApp(config(), { pg: fakePg(), redis: brokenRedis });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeader(),
      payload: chatPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('consumeToken (token bucket wrapper)', () => {
  it('passes args in the order the Lua script expects and maps the result', async () => {
    const redis = { eval: vi.fn().mockResolvedValue([1, 5, 0]) };
    const result = await consumeToken(redis, {
      key: 'ratelimit:1',
      capacity: 10,
      refillPerSec: 1,
      cost: 1,
      now: 1000,
    });

    expect(result).toEqual({ allowed: true, remaining: 5, retryAfter: 0 });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'ratelimit:1',
      10,
      1,
      1000,
      1,
    );
  });
});
