import { describe, it, expect, vi } from 'vitest';
import { fetchWithRetry } from '../src/lib/http.js';

// tiny delays so retry tests stay fast
const fast = { baseDelayMs: 1, maxDelayMs: 1, retries: 2 };
const ok = (status) => ({ status });

describe('fetchWithRetry', () => {
  it('retries a 5xx then returns the eventual success', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok(503))
      .mockResolvedValueOnce(ok(502))
      .mockResolvedValueOnce(ok(200));

    const res = await fetchWithRetry('http://x', {}, { ...fast, fetchImpl });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('returns the final 5xx after exhausting retries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(503));
    const res = await fetchWithRetry('http://x', {}, { ...fast, fetchImpl });
    expect(res.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it('retries a thrown connection error then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(ok(200));
    const res = await fetchWithRetry('http://x', {}, { ...fast, fetchImpl });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 4xx (a retry would not help)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(400));
    const res = await fetchWithRetry('http://x', {}, { ...fast, fetchImpl });
    expect(res.status).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting retries on a persistent connection error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      fetchWithRetry('http://x', {}, { ...fast, fetchImpl }),
    ).rejects.toThrow('ECONNREFUSED');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry when the external signal is already aborted', async () => {
    const fetchImpl = vi.fn();
    const signal = AbortSignal.abort();
    await expect(
      fetchWithRetry('http://x', {}, { ...fast, fetchImpl, signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
