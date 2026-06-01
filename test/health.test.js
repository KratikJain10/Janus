import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

describe('GET /health', () => {
  let app;

  beforeAll(async () => {
    // why: use the test env so config validation passes without real services.
    const config = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    app = buildApp(config);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
  });
});
