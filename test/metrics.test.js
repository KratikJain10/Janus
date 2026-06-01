import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { metrics } from '../src/lib/metrics.js';
import { fakePg, fakeRedis, authHeader, chatPayload } from './helpers.js';

describe('GET /metrics', () => {
  let app;

  beforeEach(async () => {
    metrics.reset();
    const config = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      GROQ_API_KEY: 'gsk_test',
    });
    app = buildApp(config, { pg: fakePg(), redis: fakeRedis() });
    await app.ready();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 'x',
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
            choices: [{ message: { role: 'assistant', content: 'hi' } }],
          }),
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it('exposes Prometheus metrics after handling requests', async () => {
    // one chat request (cache MISS) + one health check
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeader(),
      payload: chatPayload(),
    });
    await app.inject({ method: 'GET', url: '/health' });

    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');

    const body = res.payload;
    // request counter, labeled by route + status
    expect(body).toContain(
      'janus_requests_total{route="/v1/chat/completions",status="200"} 1',
    );
    expect(body).toContain(
      'janus_requests_total{route="/health",status="200"} 1',
    );
    // latency histogram present
    expect(body).toContain('# TYPE janus_request_duration_seconds histogram');
    expect(body).toContain('janus_request_duration_seconds_bucket{le="+Inf"}');
    expect(body).toContain('janus_request_duration_seconds_count');
    // cache accounting: the chat request was a miss
    expect(body).toContain('janus_cache_misses_total 1');
    expect(body).toContain('janus_cache_hits_total 0');
    expect(body).toContain('janus_cache_hit_ratio 0');
  });
});
