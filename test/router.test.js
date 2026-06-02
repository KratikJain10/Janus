import { describe, it, expect, beforeEach, vi } from 'vitest';
import { executeWithFallback, resetBreakers } from '../src/providers/router.js';

const A = { name: 'a', baseUrl: 'http://a', apiKey: 'k', models: [] };
const B = { name: 'b', baseUrl: 'http://b', apiKey: 'k', models: [] };

// treat a result with status>=500 as a failure (mirrors the chat route)
const opts = (extra = {}) => ({
  isFailure: (r) => r.status >= 500,
  failureThreshold: 3,
  cooldownMs: 1000,
  ...extra,
});

describe('executeWithFallback', () => {
  beforeEach(() => resetBreakers());

  it('returns the first provider on success (no fallback)', async () => {
    const attempt = vi.fn(async (p) => ({ status: 200, who: p.name }));
    const { provider, result } = await executeWithFallback(
      [A, B],
      attempt,
      opts(),
    );
    expect(provider.name).toBe('a');
    expect(result.who).toBe('a');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('falls back to the next provider when the first throws', async () => {
    const attempt = vi.fn(async (p) => {
      if (p.name === 'a') throw new Error('connection refused');
      return { status: 200, who: p.name };
    });
    const { provider } = await executeWithFallback([A, B], attempt, opts());
    expect(provider.name).toBe('b');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('falls back when the first returns a 5xx', async () => {
    const attempt = vi.fn(async (p) =>
      p.name === 'a' ? { status: 503 } : { status: 200 },
    );
    const { provider, result } = await executeWithFallback(
      [A, B],
      attempt,
      opts(),
    );
    expect(provider.name).toBe('b');
    expect(result.status).toBe(200);
  });

  it('returns the last failed result when every provider fails', async () => {
    const attempt = vi.fn(async () => ({ status: 503 }));
    const { provider, result } = await executeWithFallback(
      [A, B],
      attempt,
      opts(),
    );
    expect(result.status).toBe(503);
    expect(provider.name).toBe('b'); // the last one tried
  });

  it('throws when every provider throws', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('down');
    });
    await expect(executeWithFallback([A, B], attempt, opts())).rejects.toThrow(
      'down',
    );
  });

  it('opens the breaker after the threshold and then skips that provider', async () => {
    // A always 5xx; B always ok. Threshold 3 → after 3 failed calls A is open.
    const attempt = vi.fn(async (p) =>
      p.name === 'a' ? { status: 503 } : { status: 200 },
    );

    // 3 requests trip A's breaker (each falls back to B).
    for (let i = 0; i < 3; i++) {
      const { provider } = await executeWithFallback([A, B], attempt, opts());
      expect(provider.name).toBe('b');
    }
    const callsBefore = attempt.mock.calls.filter(
      (c) => c[0].name === 'a',
    ).length;
    expect(callsBefore).toBe(3);

    // 4th request: A's breaker is open, so A is skipped entirely.
    const { provider } = await executeWithFallback([A, B], attempt, opts());
    expect(provider.name).toBe('b');
    const callsAfter = attempt.mock.calls.filter(
      (c) => c[0].name === 'a',
    ).length;
    expect(callsAfter).toBe(3); // unchanged — A was not called again
  });

  it('throws all_providers_unavailable when every breaker is open', async () => {
    const attempt = vi.fn(async () => ({ status: 503 }));
    // trip both A and B (threshold 3, single-provider lists so each call hits one)
    for (let i = 0; i < 3; i++) {
      await executeWithFallback([A], attempt, opts());
      await executeWithFallback([B], attempt, opts());
    }
    await expect(
      executeWithFallback([A, B], attempt, opts()),
    ).rejects.toMatchObject({ code: 'all_providers_unavailable' });
  });
});
