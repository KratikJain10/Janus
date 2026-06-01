import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { TEST_KEY_ROW, fakeRedis, authHeader } from './helpers.js';

// pg fake that answers auth + the two /v1/usage aggregate queries.
function usagePg() {
  return {
    query: vi.fn(async (sql) => {
      if (/from api_keys/i.test(sql)) return { rows: [TEST_KEY_ROW] };
      if (/group by model/i.test(sql)) {
        return {
          rows: [
            {
              model: 'llama-3.1-8b-instant',
              requests: 3,
              tokens_in: 30,
              tokens_out: 12,
              cost: '0.000123',
            },
          ],
        };
      }
      if (/from usage_logs/i.test(sql)) {
        return {
          rows: [
            {
              requests: 3,
              tokens_in: 30,
              tokens_out: 12,
              cost: '0.000123',
              cache_hits: 1,
            },
          ],
        };
      }
      return { rows: [] };
    }),
  };
}

describe('GET /v1/usage', () => {
  let app;

  beforeEach(async () => {
    const config = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    app = buildApp(config, { pg: usagePg(), redis: fakeRedis() });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/usage' });
    expect(res.statusCode).toBe(401);
  });

  it('returns a per-key usage + cost summary', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.key_id).toBe(TEST_KEY_ROW.id);
    expect(body.totals).toEqual({
      requests: 3,
      tokens_in: 30,
      tokens_out: 12,
      cost: 0.000123, // coerced from pg's numeric string
      cache_hits: 1,
    });
    expect(body.by_model[0]).toMatchObject({
      model: 'llama-3.1-8b-instant',
      requests: 3,
      cost: 0.000123,
    });
  });
});
