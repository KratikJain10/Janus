import { loadProviders } from '../config/providers.js';

// Per-provider circuit breaker state, shared across requests in this process.
// name -> { failures, openUntil }
const breakers = new Map();

/**
 * The ordered list of providers to try for a request. Primary first, then
 * fallbacks (config order).
 *
 * When `model` is given, restrict the chain to providers that can serve it:
 * a provider with an empty `models` list is a wildcard (serves anything), while
 * one that declares models only matches those. This is model-aware routing — it
 * lets you point a model at a specific provider (and still get fallback among the
 * providers that serve it) without taking the primary offline to force failover.
 */
export function getProviderChain(config, model) {
  const providers = loadProviders(config);
  if (!model) return providers;
  return providers.filter(
    (p) => p.models.length === 0 || p.models.includes(model),
  );
}

function isBreakerOpen(name, now) {
  const b = breakers.get(name);
  return Boolean(b && b.openUntil > now);
}

function recordFailure(name, { threshold, cooldownMs }, now) {
  const b = breakers.get(name) ?? { failures: 0, openUntil: 0 };
  b.failures += 1;
  if (b.failures >= threshold) {
    // why: trip the breaker — stop sending traffic to a failing provider for a
    // cooldown so it can recover (and we fail over faster meanwhile).
    b.openUntil = now + cooldownMs;
    b.failures = 0;
  }
  breakers.set(name, b);
}

function recordSuccess(name) {
  breakers.set(name, { failures: 0, openUntil: 0 });
}

/** Test/ops helper: clear all breaker state. */
export function resetBreakers() {
  breakers.clear();
}

/**
 * Try each provider in order until one succeeds, skipping providers whose
 * breaker is open. `attempt(provider)` performs the call (with its own retries);
 * `isFailure(result)` flags a returned-but-failed result (e.g. a 5xx) so we fall
 * back instead of returning it.
 *
 * Returns { provider, result } from the first success — or the last failed
 * result if every provider returned a failure. Throws when every provider threw
 * (network/timeout), or with code 'all_providers_unavailable' when all breakers
 * were open. An external `signal` abort stops the loop without tripping breakers.
 */
export async function executeWithFallback(providers, attempt, opts = {}) {
  const {
    isFailure = () => false,
    failureThreshold = 5,
    cooldownMs = 15000,
    signal,
    log,
    now = Date.now,
  } = opts;
  const breakerOpts = { threshold: failureThreshold, cooldownMs };

  let lastResult = null;
  let lastError = null;
  let triedAny = false;

  for (const provider of providers) {
    if (signal?.aborted) {
      const err = new Error('request aborted');
      err.name = 'AbortError';
      throw err;
    }
    if (isBreakerOpen(provider.name, now())) {
      log?.warn({ provider: provider.name }, 'circuit open, skipping provider');
      continue;
    }
    triedAny = true;

    try {
      const result = await attempt(provider);
      if (isFailure(result)) {
        recordFailure(provider.name, breakerOpts, now());
        log?.warn(
          { provider: provider.name },
          'provider returned a failure, falling back',
        );
        lastResult = { provider, result };
        continue;
      }
      recordSuccess(provider.name);
      return { provider, result };
    } catch (err) {
      // why: client cancellation isn't the provider's fault — don't penalize it.
      if (signal?.aborted) throw err;
      recordFailure(provider.name, breakerOpts, now());
      log?.warn(
        { provider: provider.name, err: err.message },
        'provider threw, falling back',
      );
      lastError = err;
    }
  }

  // why: every provider returned a (retry-exhausted) failure response — hand the
  // last one back so the client sees the real upstream status, not a generic 502.
  if (lastResult) return lastResult;
  if (!triedAny) {
    const err = new Error('all providers unavailable (circuit open)');
    err.code = 'all_providers_unavailable';
    throw err;
  }
  throw lastError ?? new Error('all providers failed');
}
