import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { fakePg, fakeRedis } from './helpers.js';

describe('GET /dashboard', () => {
  let app;

  beforeEach(async () => {
    const config = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    app = buildApp(config, { pg: fakePg(), redis: fakeRedis() });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves the dashboard HTML page (public, no key)', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.payload).toContain('Janus');
    // it reads from the gateway's own endpoints
    expect(res.payload).toContain('/v1/usage');
    expect(res.payload).toContain('/metrics');
  });
});
