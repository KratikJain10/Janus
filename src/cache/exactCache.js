import { sha256, stableStringify } from '../lib/hash.js';

// Request fields that actually change the completion. Everything else (stream,
// user, custom metadata) is ignored so it doesn't needlessly fragment the cache.
const CACHEABLE_FIELDS = [
  'model',
  'messages',
  'temperature',
  'top_p',
  'max_tokens',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'n',
  'response_format',
  'tools',
  'tool_choice',
];

/** Pick only the fields that affect the response. */
export function normalizeRequest(body) {
  const normalized = {};
  for (const field of CACHEABLE_FIELDS) {
    if (body[field] !== undefined) normalized[field] = body[field];
  }
  return normalized;
}

/**
 * Build the Redis cache key for a request. Namespaced by provider so the same
 * prompt sent to different upstreams doesn't collide once routing exists.
 *
 * why: this is an EXACT-match cache — any change to a cacheable field yields a
 * different key. (Identical requests with temperature>0 intentionally reuse the
 * first response; that's the cost/latency trade-off. Semantic cache is Phase 7.)
 */
export function cacheKey(body, namespace = 'default') {
  const hash = sha256(stableStringify(normalizeRequest(body)));
  return `cache:${namespace}:${hash}`;
}

/** Return the cached response object, or null on miss / parse failure. */
export async function getCachedResponse(redis, key) {
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // why: a corrupt entry should behave as a miss, never crash the request.
    return null;
  }
}

/** Store a response JSON with a TTL (SET key value EX ttl). */
export async function setCachedResponse(redis, key, value, ttlSeconds) {
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
}
