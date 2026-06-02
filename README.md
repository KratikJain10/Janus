<div align="center">

# Janus

**A self-hostable, OpenAI-compatible LLM API gateway.**

One endpoint in front of any LLM provider — with the auth, rate limiting, caching, reliability, and cost tracking that production AI apps need but shouldn't rebuild.

[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Fastify](https://img.shields.io/badge/built%20with-Fastify-000000?logo=fastify&logoColor=white)](https://fastify.dev)
[![Tests](https://img.shields.io/badge/tests-62%20passing-brightgreen?logo=vitest&logoColor=white)](#testing)
[![Code style](https://img.shields.io/badge/code%20style-prettier-ff69b4?logo=prettier&logoColor=white)](https://prettier.io)
[![License](https://img.shields.io/badge/license-ISC-blue)](#license)

</div>

---

## Why this exists

Real AI products rarely call provider APIs directly. They put a **gateway** in front to control cost, add reliability, and observe usage. Janus implements that gateway from scratch — the interesting engineering is the proxying, streaming, caching, rate limiting, failure handling, and observability, *not* the LLM call itself.

Named after the Roman god of gates, doorways, and transitions. 🏛️

## Highlights

- 🔌 **Drop-in OpenAI compatibility** — `POST /v1/chat/completions`, streaming and non-streaming. Point your existing OpenAI SDK at it.
- 🔑 **API-key auth** — client keys stored as SHA-256 hashes in Postgres (the plaintext key is shown once, never stored).
- 🚦 **Per-key rate limiting** — token bucket in Redis, evaluated atomically in a single Lua script so it's correct under concurrency.
- ⚡ **Two-layer caching** — exact-match (Redis, hashed request) and optional **semantic** (pgvector cosine search) that serves near-duplicate prompts.
- 🛟 **Reliability** — per-attempt timeout, retries with capped exponential backoff + jitter, automatic **fallback** to the next provider, and a per-provider **circuit breaker**.
- 📊 **Observability** — per-request tokens/latency/cost persisted to Postgres, a `/v1/usage` summary, Prometheus `/metrics`, and a minimal `/dashboard`.
- 🧩 **Provider-agnostic** — a provider is just config `{ name, baseUrl, apiKey }`. Adding one is config, not code.

## Architecture

```
Client
  │
  ▼
Fastify
  ├─ auth hook          validate client API key (Postgres)
  ├─ rate-limit hook    token bucket in Redis (atomic Lua)
  ├─ exact cache        Redis, hashed request           ──hit──▶ return
  ├─ semantic cache     pgvector cosine similarity       ──hit──▶ return
  ├─ router             pick provider + fallback order, circuit breaker
  │     └─ upstream     fetch( timeout → retry+backoff → fallback )
  ├─ response           SSE stream  OR  JSON
  └─ onResponse         persist tokens/latency/cost; record metrics
```

Auth and rate limiting are Fastify `preHandler` plugins; Redis and the Postgres pool are exposed via decorator plugins (`fastify.redis`, `fastify.pg`). The app is built (`buildApp`) separately from the server (`server.js`) so tests run against the real app via `fastify.inject()`.

## Tech stack

**Node.js** (ES modules) · **Fastify** · **pino** · **Redis** · **PostgreSQL** (`pg`, raw SQL) + **pgvector** · **zod** · native `fetch`/**undici** · **vitest** · **ESLint** + **Prettier** · **Docker Compose**.

## Quick start

```bash
# 1 — backing services (Redis + Postgres-with-pgvector)
docker compose up -d

# 2 — configure
cp .env.example .env          # set GROQ_API_KEY (free tier at console.groq.com)

# 3 — install, migrate, mint a client key
npm install
npm run migrate
npm run mint-key -- --name dev --rpm 100      # prints a jns_… key ONCE

# 4 — run (loads .env via --env-file)
npm run dev
```

### Make a request

```bash
curl http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer jns_your_key' \
  -d '{
    "model": "llama-3.1-8b-instant",
    "messages": [{ "role": "user", "content": "Say hello in one sentence." }]
  }'
```

Streaming is the same call with `"stream": true` — tokens arrive as Server-Sent Events:

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' -H 'authorization: Bearer jns_your_key' \
  -d '{"model":"llama-3.1-8b-instant","stream":true,
       "messages":[{"role":"user","content":"Count to five."}]}'
```

Responses carry gateway headers: `x-cache` (`HIT`/`MISS`), `x-cache-type` (`exact`/`semantic`), and `x-provider` (which upstream actually served the request).

## Endpoints

| Method | Path | Auth | Description |
| --- | --- | :---: | --- |
| `POST` | `/v1/chat/completions` | 🔑 | OpenAI-compatible; supports `stream: true` |
| `GET` | `/v1/usage` | 🔑 | Per-key usage + cost summary (totals + by-model) |
| `GET` | `/metrics` | — | Prometheus exposition (requests, latency histogram, cache hit ratio) |
| `GET` | `/dashboard` | — | Minimal web UI over `/v1/usage` + `/metrics` |
| `GET` | `/health` | — | Liveness |

## Configuration

Config comes entirely from the environment and is validated by **zod at startup** — the process fails fast with a clear message on anything missing or malformed (and never echoes secret values). Full list in [`.env.example`](.env.example); the essentials:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GROQ_API_KEY` | — | Primary upstream provider |
| `OLLAMA_BASE_URL` | — | Opt-in local fallback provider |
| `CACHE_ENABLED` · `CACHE_TTL_SECONDS` | `true` · `300` | Exact-match cache |
| `UPSTREAM_TIMEOUT_MS` · `UPSTREAM_MAX_RETRIES` | `30000` · `2` | Retry policy |
| `CIRCUIT_BREAKER_THRESHOLD` · `_COOLDOWN_MS` | `5` · `15000` | Per-provider circuit breaker |
| `SEMANTIC_CACHE_ENABLED` · `_THRESHOLD` | `false` · `0.95` | Semantic cache (requires `EMBEDDING_BASE_URL`) |

## Design decisions

A few choices worth calling out (the kind of thing this project is meant to demonstrate):

- **Fastify over Express** — lower per-request overhead for a throughput-oriented proxy, first-class streaming, and built-in pino logging + schema support.
- **Token bucket in one Lua script** — the entire check-refill-decrement runs server-side in Redis, so rate limiting stays correct under concurrent requests with no round-trip races.
- **Usage logged once, after fallback** — retries and provider fallback happen *below* the usage layer, so a request that fails over to a backup is billed once, to the provider that actually served it.
- **Fail-open caches, fail-fast config** — a Redis/embedding hiccup degrades to a normal upstream call rather than erroring; bad configuration crashes the process immediately at boot.
- **Streaming without buffering** — the upstream SSE stream is piped straight to the socket with backpressure; client disconnects abort the upstream so we stop paying for unread tokens.

## Testing

```bash
npm test      # vitest — uses fastify.inject() with injected pg/redis fakes (no live infra)
npm run lint  # eslint
```

62 tests cover the proxy, streaming, auth, rate limiting, both cache layers, retry/fallback/circuit-breaker semantics, cost computation, and the usage/metrics endpoints.

## Project layout

```
src/
  server.js / app.js     bootstrap + assemble Fastify
  config/                env + provider config (zod)
  plugins/               redis, pg, auth, rateLimit  (decorators / preHandlers)
  routes/                chat, usage, metrics, health, dashboard
  providers/             router (fallback + breaker) + OpenAI-compatible call
  cache/                 exact (Redis) + semantic (pgvector)
  ratelimit/             token bucket + embedded Lua
  usage/                 model price table + usage logger
  lib/                   http (timeout/retry), hash, metrics
  db/migrations/         plain .sql + a tiny migrate runner
public/                  dashboard (no-build React via CDN)
test/                    vitest suites
```

## Roadmap

Backend is feature-complete. Natural next steps:

- Model-aware routing (map models → providers) so fallback works without forcing the primary offline
- Store the serving provider in cache entries so cache-hit usage is attributed precisely
- Capture token counts from streaming responses for exact streamed-usage accounting

## License

[ISC](LICENSE)
