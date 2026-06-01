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
