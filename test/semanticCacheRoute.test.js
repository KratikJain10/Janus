import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { fakeRedis, TEST_KEY_ROW, authHeader, chatPayload } from './helpers.js';

const EMBED = [0.1, 0.2, 0.3];
const SEMANTIC_RESPONSE = {
  id: 'cached-semantic',
  choices: [{ message: { role: 'assistant', content: 'cached answer' } }],
  usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
};
const FRESH_RESPONSE = {
  id: 'fresh',
  choices: [{ message: { role: 'assistant', content: 'fresh answer' } }],
  usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
};

// pg fake: auth + a configurable semantic_cache SELECT result; records INSERTs.
function semanticPg(similarRow) {
  const inserts = [];
  const pg = {
    inserts,
    query: vi.fn(async (sql) => {
      if (/from api_keys/i.test(sql)) return { rows: [TEST_KEY_ROW] };
      if (/from semantic_cache/i.test(sql)) {
        return { rows: similarRow ? [similarRow] : [] };
      }
      if (/insert into semantic_cache/i.test(sql)) {
        inserts.push(true);
        return { rows: [] };
      }
      return { rows: [] }; // usage_logs insert, etc.
    }),
  };
  return pg;
}

function fetchRouter() {
  return vi.fn(async (url) => {
    if (String(url).includes('/embeddings')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: EMBED }] }),
      };
    }
    return { status: 200, text: async () => JSON.stringify(FRESH_RESPONSE) };
  });
}

function config() {
  return loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    GROQ_API_KEY: 'gsk_test',
    SEMANTIC_CACHE_ENABLED: 'true',
    SEMANTIC_CACHE_THRESHOLD: '0.95',
    EMBEDDING_BASE_URL: 'http://emb/v1',
  });
}

describe('semantic cache (chat route)', () => {
  let app;
  let fetchMock;

  beforeEach(() => {
    fetchMock = fetchRouter();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (app) await app.close();
  });

  it('serves a semantic HIT when the nearest prompt is above threshold', async () => {
    const pg = semanticPg({ response: SEMANTIC_RESPONSE, similarity: '0.98' });
    app = buildApp(config(), { pg, redis: fakeRedis() });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeader(),
      payload: chatPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('HIT');
    expect(res.headers['x-cache-type']).toBe('semantic');
    expect(res.headers['x-cache-similarity']).toBe('0.9800');
    expect(res.json()).toEqual(SEMANTIC_RESPONSE);

    // embeddings were called, but the chat upstream was NOT
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/embeddings'))).toBe(true);
    expect(calls.some((u) => u.includes('/chat/completions'))).toBe(false);
  });

  it('falls through to the upstream and stores the embedding on a miss', async () => {
    const pg = semanticPg(null); // no similar row
    app = buildApp(config(), { pg, redis: fakeRedis() });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeader(),
      payload: chatPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('MISS');
    expect(res.json()).toEqual(FRESH_RESPONSE);

    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/embeddings'))).toBe(true);
    expect(calls.some((u) => u.includes('/chat/completions'))).toBe(true);
    // the fresh response was stored for future similarity lookups
    expect(pg.inserts.length).toBe(1);
  });

  it('treats a below-threshold nearest match as a miss', async () => {
    const pg = semanticPg({ response: SEMANTIC_RESPONSE, similarity: '0.80' });
    app = buildApp(config(), { pg, redis: fakeRedis() });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeader(),
      payload: chatPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('MISS');
    expect(res.json()).toEqual(FRESH_RESPONSE);
  });
});
