import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULTS = {
  retries: 2,
  timeoutMs: 30000,
  baseDelayMs: 200,
  maxDelayMs: 2000,
};

// why: full-jitter capped exponential backoff — spreads retries so a recovering
// upstream isn't hit by a synchronized thundering herd.
function backoffDelay(attempt, baseMs, maxMs) {
  const capped = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.random() * capped;
}

function abortError() {
  const err = new Error('request aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * fetch with a per-attempt timeout and capped exponential backoff + jitter.
 * Retries only failures that might succeed on a retry: connection errors,
 * timeouts, and 5xx responses. 4xx responses are returned as-is (a retry won't
 * help). On a 5xx that exhausts retries, the final 5xx response is returned so
 * the caller can decide to fall back.
 *
 * An external `signal` (e.g. client disconnect) aborts immediately and is NOT
 * retried.
 */
export async function fetchWithRetry(url, options = {}, opts = {}) {
  const {
    retries,
    timeoutMs,
    baseDelayMs,
    maxDelayMs,
    signal: externalSignal,
    fetchImpl = globalThis.fetch,
    log,
  } = { ...DEFAULTS, ...opts };

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (externalSignal?.aborted) throw abortError();

    // why: each attempt gets its own timeout; combine it with the external
    // signal so either a timeout or a client disconnect aborts the fetch.
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const res = await fetchImpl(url, { ...options, signal });
      clearTimeout(timer);

      if (res.status >= 500 && attempt < retries) {
        log?.warn(
          { url, status: res.status, attempt },
          'upstream 5xx, retrying',
        );
        await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      // why: client cancelled — surface immediately, never retry.
      if (externalSignal?.aborted) throw err;

      lastError = err;
      if (attempt < retries) {
        log?.warn(
          { url, err: err.message, attempt },
          'upstream connection/timeout error, retrying',
        );
        await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
        continue;
      }
      throw err;
    }
  }
  // unreachable: the loop always returns or throws on the final attempt.
  throw lastError ?? new Error('fetchWithRetry exhausted');
}
