-- One row per billable request: who made it, where it went, how many tokens,
-- how long it took, and what it cost. Powers GET /v1/usage and cost reporting.
CREATE TABLE IF NOT EXISTS usage_logs (
  id           bigserial PRIMARY KEY,
  api_key_id   uuid NOT NULL REFERENCES api_keys (id),
  provider     text NOT NULL,
  model        text NOT NULL,
  -- token counts are nullable: streaming responses and upstream errors may not
  -- report them.
  tokens_in    integer,
  tokens_out   integer,
  total_tokens integer,
  latency_ms   integer,
  -- null = unknown-model pricing (we don't guess); numeric for exact money math.
  cost         numeric(12, 6),
  cached       boolean NOT NULL DEFAULT false,
  status       integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- why: /v1/usage filters by key; time index supports windowed reporting later.
CREATE INDEX IF NOT EXISTS usage_logs_api_key_id_idx ON usage_logs (api_key_id);
CREATE INDEX IF NOT EXISTS usage_logs_created_at_idx ON usage_logs (created_at);
