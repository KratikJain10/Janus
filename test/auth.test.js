import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { fakePg, fakeRedis, authHeader, chatPayload } from './helpers.js';

describe('auth preHandler', () => {
  let app;
  let fetchMock;

  beforeEach(async () => {
    const config = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      GROQ_API_KEY: 'gsk_test',
    });
    app = buildApp(config, { pg: fakePg(), redis: fakeRedis() });
    await app.ready();

    fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it('rejects a request with no API key (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: chatPayload(),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.type).toBe('authentication_error');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown API key (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeader('jns_wrong'),
      payload: chatPayload(),
    });
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows a valid API key through to the upstream', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeader(),
      payload: chatPayload(),
    });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves /health open (no key required)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});
