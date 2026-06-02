# Janus

A self-hostable, OpenAI-compatible **LLM API gateway**. Clients call one endpoint; Janus adds the production concerns every AI app needs but shouldn't rebuild: auth, rate limiting, caching, retries/fallback across providers, and per-key cost + usage tracking.

Named after the Roman god of gates and transitions — apt for an API gateway.

## Why

Real AI products don't call provider APIs directly — they put a gateway in front to control cost, add reliability, and observe usage. Janus implements that gateway from scratch to demonstrate practical backend engineering (proxying, streaming, caching, rate limiting, failure handling, observability) — not to call an LLM API.

## Features

- **OpenAI-compatible** `POST /v1/chat/completions`, streaming (`stream: true`) and non-streaming
- **Auth** — client API keys stored as SHA-256 hashes in Postgres
- **Rate limiting** — per-key token bucket in Redis, atomic via a single Lua script
- **Exact-match cache** — normalized + hashed requests cached in Redis with TTL
- **Semantic cache** *(optional)* — embed the prompt, pgvector cosine search, serve near-duplicate prompts above a similarity threshold
- **Reliability** — retry (timeout / 5xx / connection errors) with capped backoff + jitter, fallback to the next provider, per-provider circuit breaker
- **Observability** — per-request usage + cost in Postgres, `GET /v1/usage`, Prometheus `GET /metrics`, and a minimal `/dashboard`
- **Provider-agnostic** — a provider is just config `{ name, baseUrl, apiKey }`; adding one = adding config, not code

## Architecture

```
Client
  -> Fastify
  -> auth hook         (validate client API key from Postgres)
  -> rate-limit hook   (token bucket in Redis, atomic Lua)
  -> exact cache       (Redis)            --hit--> return
  -> semantic cache    (pgvector)         --hit--> return
  -> router            (pick provider + fallback order, circuit breaker)
  -> upstream call     (fetch w/ timeout -> retry+backoff -> fallback)
  -> response          (SSE stream OR JSON)
  -> onResponse        (log tokens/latency/cost to Postgres; record metrics)
```

## Tech stack

Node.js (ESM) · Fastify · pino · Redis · PostgreSQL (`pg`, raw SQL) + pgvector · zod · undici/`fetch` · vitest · ESLint + Prettier · Docker Compose.

## Quick start

```bash
# 1. Backing services (Redis + Postgres with pgvector)
docker compose up -d

# 2. Config
cp .env.example .env        # add your GROQ_API_KEY

# 3. Schema + an API key
npm install
npm run migrate
npm run mint-key -- --name dev --rpm 100   # prints a jns_... key once

# 4. Run
npm run dev                  # loads .env via --env-file
```

```bash
# Call it
curl -s http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer jns_...' \
  -d '{"model":"llama-3.1-8b-instant","messages":[{"role":"user","content":"hello"}]}'
```

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/chat/completions` | key | OpenAI-compatible; supports `stream: true` |
| GET | `/v1/usage` | key | Per-key usage + cost summary |
| GET | `/metrics` | — | Prometheus exposition format |
| GET | `/dashboard` | — | Minimal usage/metrics UI (prompts for a key) |
| GET | `/health` | — | Liveness |

Response headers include `x-cache` (HIT/MISS), `x-cache-type` (exact/semantic), and `x-provider` (which upstream served).

## Configuration

All config is env, validated by zod at startup (the process fails fast on bad/missing values). See [.env.example](.env.example). Highlights:

| Var | Default | Purpose |
|---|---|---|
| `GROQ_API_KEY` | — | Primary provider key |
| `OLLAMA_BASE_URL` | — | Opt-in local fallback provider |
| `CACHE_ENABLED` / `CACHE_TTL_SECONDS` | `true` / `300` | Exact-match cache |
| `UPSTREAM_TIMEOUT_MS` / `UPSTREAM_MAX_RETRIES` | `30000` / `2` | Retry policy |
| `CIRCUIT_BREAKER_THRESHOLD` / `_COOLDOWN_MS` | `5` / `15000` | Circuit breaker |
| `SEMANTIC_CACHE_ENABLED` / `_THRESHOLD` | `false` / `0.95` | Semantic cache (needs `EMBEDDING_BASE_URL`) |

## Development

```bash
npm test         # vitest (fastify.inject + injected fakes — no live infra needed)
npm run lint     # eslint
npm run format   # prettier
```

## Project layout

```
src/
  server.js / app.js     # bootstrap + assemble Fastify
  config/                # env + provider config (zod)
  plugins/               # redis, pg, auth, rateLimit (decorators / hooks)
  routes/                # chat, usage, metrics, health, dashboard
  providers/             # router (fallback + breaker) + openai-compatible call
  cache/                 # exact (Redis) + semantic (pgvector)
  ratelimit/             # token bucket + Lua
  usage/                 # cost table + usage logger
  lib/                   # http (retry), hash, metrics
  db/migrations/         # plain .sql + a tiny migrate runner
```

## License

ISC
