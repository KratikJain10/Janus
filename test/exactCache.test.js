import { describe, it, expect, vi } from 'vitest';
import {
  cacheKey,
  normalizeRequest,
  getCachedResponse,
  setCachedResponse,
} from '../src/cache/exactCache.js';

describe('exactCache', () => {
  it('builds the same key regardless of field/object key order', () => {
    const a = {
      model: 'm',
      temperature: 0.2,
      messages: [{ role: 'user', content: 'hi' }],
    };
    const b = {
      messages: [{ content: 'hi', role: 'user' }],
      model: 'm',
      temperature: 0.2,
    };
    expect(cacheKey(a, 'groq')).toBe(cacheKey(b, 'groq'));
  });

  it('changes the key when a cacheable field changes', () => {
    const base = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    expect(cacheKey(base, 'groq')).not.toBe(
      cacheKey({ ...base, temperature: 0.9 }, 'groq'),
    );
  });

  it('namespaces by provider', () => {
    const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    expect(cacheKey(body, 'groq')).not.toBe(cacheKey(body, 'openai'));
  });

  it('ignores non-cacheable fields (stream, user)', () => {
    const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    const norm = normalizeRequest({ ...body, stream: true, user: 'abc' });
    expect(norm).not.toHaveProperty('stream');
    expect(norm).not.toHaveProperty('user');
    expect(cacheKey(body, 'groq')).toBe(
      cacheKey({ ...body, stream: true, user: 'abc' }, 'groq'),
    );
  });

  it('round-trips a response through get/set, and misses on unknown keys', async () => {
    const store = new Map();
    const redis = {
      get: vi.fn(async (k) => store.get(k) ?? null),
      set: vi.fn(async (k, v) => store.set(k, v)),
    };
    const value = { id: 'x', choices: [] };

    expect(await getCachedResponse(redis, 'k1')).toBeNull();
    await setCachedResponse(redis, 'k1', value, 300);
    expect(redis.set).toHaveBeenCalledWith(
      'k1',
      JSON.stringify(value),
      'EX',
      300,
    );
    expect(await getCachedResponse(redis, 'k1')).toEqual(value);
  });

  it('treats a corrupt cache entry as a miss', async () => {
    const redis = { get: vi.fn(async () => 'not json{') };
    expect(await getCachedResponse(redis, 'k1')).toBeNull();
  });
});
