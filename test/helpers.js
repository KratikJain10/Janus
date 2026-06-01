import { vi } from 'vitest';
import { sha256 } from '../src/lib/hash.js';

// Shared test fixtures for the auth + rate-limit paths.
export const TEST_TOKEN = 'jns_test_valid_key';
export const TEST_KEY_ROW = {
  id: 'key-1',
  name: 'test',
  rate_limit_rpm: 60,
  key_hash: sha256(TEST_TOKEN),
};

export const authHeader = (token = TEST_TOKEN) => ({
  authorization: `Bearer ${token}`,
});

/** Fake pg pool: resolves the api_keys lookup against TEST_KEY_ROW by hash. */
export function fakePg(keyRow = TEST_KEY_ROW) {
  return {
    query: vi.fn(async (sql, params) => {
      if (/from api_keys/i.test(sql)) {
        return params[0] === keyRow.key_hash
          ? { rows: [keyRow] }
          : { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

/** Fake redis whose token-bucket eval returns a fixed [allowed, remaining, retry]. */
export function fakeRedis([allowed, remaining, retry] = [1, 59, 0]) {
  return { eval: vi.fn(async () => [allowed, remaining, retry]) };
}

export const chatPayload = () => ({
  model: 'llama-3.1-8b-instant',
  messages: [{ role: 'user', content: 'hi' }],
});
