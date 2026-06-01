// Token-bucket rate limiter as a SINGLE Lua script so the whole
// read -> refill -> check -> decrement -> persist cycle is atomic on Redis,
// even under concurrent requests for the same key.
//
// KEYS[1] = bucket key (e.g. "ratelimit:<apiKeyId>")
// ARGV[1] = capacity        (max tokens / burst)
// ARGV[2] = refillPerSec    (tokens added per second)
// ARGV[3] = now             (current time, ms since epoch)
// ARGV[4] = cost            (tokens this request consumes)
// returns { allowed (1/0), remaining (int), retryAfter (seconds) }
export const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local refill   = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])
local cost     = tonumber(ARGV[4])

local state  = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts     = tonumber(state[2])
if tokens == nil then
  tokens = capacity
  ts = now
end

-- refill by however much time has elapsed, capped at capacity
local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
-- why: let idle buckets expire so we don't leak keys; full-refill time + 1s.
local ttl = math.ceil(capacity / refill) + 1
redis.call('EXPIRE', KEYS[1], ttl)

local retryAfter = 0
if allowed == 0 then
  retryAfter = math.ceil((cost - tokens) / refill)
end

return { allowed, math.floor(tokens), retryAfter }
`;

/**
 * Run the token-bucket script and map its array result to an object.
 * `redis` is any ioredis-compatible client exposing eval(script, numKeys, ...).
 */
export async function consumeToken(
  redis,
  { key, capacity, refillPerSec, cost = 1, now = Date.now() },
) {
  const [allowed, remaining, retryAfter] = await redis.eval(
    TOKEN_BUCKET_LUA,
    1,
    key,
    capacity,
    refillPerSec,
    now,
    cost,
  );
  return { allowed: allowed === 1, remaining, retryAfter };
}
