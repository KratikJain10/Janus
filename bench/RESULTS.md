# Janus — load test results

Real, reproduced numbers comparing the **cached path** (gateway + Redis) against
the **uncached path** (gateway → Groq). Nothing here is fabricated — re-run the
commands below to reproduce.

## Environment

| | |
|---|---|
| Machine | AMD Ryzen 7 4800H (16 threads) |
| Node | v20.20.2 |
| Gateway | single process, `npm start` |
| Backing services | Redis 7 + Postgres 16 (pgvector) via `docker compose`, all localhost |
| Upstream | Groq, model `llama-3.1-8b-instant` |
| Tool | autocannon (cached path) + a fetch driver (uncached path) |
| Date | 2026-06-02 |

## How it was run

```bash
docker compose up -d
npm run migrate
npm run mint-key -- --name bench --rpm 6000000   # high rpm so rate limiting isn't the bottleneck
npm start

# cached path (prewarms one entry, then hammers the identical request) + uncached path
BENCH_KEY=jns_... bench/run.sh

# clean, throttled uncached latency run (stays under Groq's free-tier tokens/min):
BENCH_KEY=jns_... MISS_C=1 MISS_A=15 MISS_DELAY=2500 node bench/uncached.js
```

## Results

### Cached path — 50 connections, 15s (all exact-cache hits)

| Metric | Value |
|---|---|
| Throughput | **1,542 req/s** |
| Requests | 23,134 (0 non-2xx) |
| Latency mean | 31.9 ms |
| Latency p90 | 38 ms |
| Latency p97.5 | 51 ms |
| Latency p99 | 64 ms |
| Latency max | 146 ms |

### Uncached path — sequential, throttled (gateway → Groq)

Throughput here is bounded by **Groq's free-tier tokens-per-minute limit**, not by
Janus — bursting trips upstream 429s — so this run is throttled to measure clean
per-call latency, not gateway throughput.

| Metric | Value |
|---|---|
| Requests | 15 (15 ok, 0 failed) |
| Latency mean | 265 ms |
| Latency p50 | 243 ms |
| Latency p95 | 644 ms |
| Latency max | 644 ms |

### Cache effectiveness (from `/metrics` during the cached run)

| Metric | Value |
|---|---|
| Cache hits | 23,148 |
| Cache misses | 1 |
| **Hit ratio** | **99.996%** |

## What this means

- **Latency:** a cache hit returns in ~32 ms mean / 64 ms p99 vs ~243 ms p50 /
  644 ms p95 for a live Groq call — roughly an **8× faster median** and a far
  tighter tail, because the hit never leaves the process+Redis.
- **Throughput:** the gateway sustained **1.5K req/s** on a single Node process
  on the cached path. The uncached ceiling is the upstream's, which is exactly
  why a cache sits in front of it.
- **Cost:** every hit avoids 100% of the upstream token cost. At
  `llama-3.1-8b-instant` rates (~$0.00000266 per ~49-token call), the 23,148 hits
  in this 15s run avoided **~$0.062** of Groq spend — and at 99.996% hit ratio,
  ~all repeat traffic is served for free. The savings scale linearly with traffic
  and with how repetitive the prompts are.

## Files

- `run.sh` — cached vs uncached driver; writes raw JSON to `results/`.
- `uncached.js` — fetch-based upstream driver (unique prompt per request → always a MISS).
- `summarize.js` — prints headline numbers from an autocannon `--json` result.
- `results/` — raw `cached.json`, `uncached.json`, `metrics.txt`.
