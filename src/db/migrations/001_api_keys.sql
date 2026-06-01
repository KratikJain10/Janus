-- Client API keys. We store only a SHA-256 hash of each key, never the key
-- itself, so a database leak can't be replayed against the gateway.
CREATE TABLE IF NOT EXISTS api_keys (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  key_hash       text NOT NULL UNIQUE,
  -- per-key requests/minute; the token bucket uses this as both burst
  -- capacity and (rpm / 60) refill-per-second.
  rate_limit_rpm integer NOT NULL DEFAULT 60,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  -- set to revoke a key without deleting its usage history.
  revoked_at     timestamptz
);

-- why: every request looks a key up by its hash, so index it.
CREATE INDEX IF NOT EXISTS api_keys_key_hash_idx ON api_keys (key_hash);
