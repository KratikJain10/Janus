import { createHash } from 'node:crypto';

/**
 * SHA-256 hex digest. Used to hash client API keys before storage/lookup
 * (and, in Phase 4, to hash normalized requests for the cache key).
 *
 * why: API keys are high-entropy random tokens, so a fast cryptographic hash
 * is the right tool — bcrypt/argon2 are for low-entropy human passwords.
 */
export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Deterministic JSON: object keys are sorted recursively so that two logically
 * equal requests serialize identically regardless of key order. Array order is
 * preserved (it's meaningful, e.g. the messages list).
 *
 * why: the cache key must be stable — {a:1,b:2} and {b:2,a:1} must hash the same.
 */
export function stableStringify(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortDeep(value[key]);
        return acc;
      }, {});
  }
  return value;
}
