#!/usr/bin/env bash
# Janus load test — cached path vs uncached (upstream) path.
#
# Produces the real numbers for the resume:
#   - requests/sec, p95/p99 latency on the CACHED path (gateway + Redis)
#   - requests/sec, p95/p99 latency on the UNCACHED path (gateway -> Groq)
#   - cache hit ratio + token/cost totals read from /metrics and /v1/usage
#
# Usage:
#   BENCH_KEY=jns_... bench/run.sh
# Env (override as needed):
#   URL        gateway base url      (default http://localhost:3000)
#   MODEL      upstream model        (default llama-3.1-8b-instant)
#   CACHE_C    cached connections    (default 50)
#   CACHE_D    cached duration (s)   (default 15)
#   MISS_C     uncached concurrency  (default 1)   -> low: Groq free tier TPM
#   MISS_A     uncached total reqs   (default 15)  -> this many REAL Groq calls
#   MISS_DELAY ms between calls      (default 2500) -> stay under Groq TPM
set -euo pipefail

URL="${URL:-http://localhost:3000}"
MODEL="${MODEL:-llama-3.1-8b-instant}"
CACHE_C="${CACHE_C:-50}"
CACHE_D="${CACHE_D:-15}"
MISS_C="${MISS_C:-1}"
MISS_A="${MISS_A:-15}"
MISS_DELAY="${MISS_DELAY:-2500}"
: "${BENCH_KEY:?set BENCH_KEY to a Janus client key (jns_...)}"

AC="$(dirname "$0")/../node_modules/.bin/autocannon"
OUT="$(dirname "$0")/results"
mkdir -p "$OUT"
AUTH=(-H "Authorization: Bearer ${BENCH_KEY}" -H "Content-Type: application/json")

# Fixed body -> identical request -> served from the exact-match cache.
CACHED_BODY="{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hi in 3 words.\"}],\"temperature\":0}"

echo "==> Prewarming the cache (one request so the cached run is 100% hits)"
curl -fsS -o /dev/null -X POST "${URL}/v1/chat/completions" "${AUTH[@]}" -d "${CACHED_BODY}"

echo
echo "================ TEST A: CACHED PATH (${CACHE_C} conns, ${CACHE_D}s) ================"
"$AC" -c "$CACHE_C" -d "$CACHE_D" -m POST "${AUTH[@]}" \
  -b "${CACHED_BODY}" --json "${URL}/v1/chat/completions" > "${OUT}/cached.json"
node "$(dirname "$0")/summarize.js" "${OUT}/cached.json" "CACHED"

echo
echo "========= TEST B: UNCACHED PATH -> GROQ (${MISS_C} conns, ${MISS_A} reqs) ========="
# why: a hand-rolled fetch driver (not autocannon) — autocannon's body rewriting
# fights us here (stale Content-Length / empty warmup bodies). Every request is a
# unique prompt, so it always misses the cache and is forwarded upstream.
MISS_C="$MISS_C" MISS_A="$MISS_A" MISS_DELAY="$MISS_DELAY" \
  BENCH_KEY="$BENCH_KEY" URL="$URL" MODEL="$MODEL" \
  node "$(dirname "$0")/uncached.js"

echo
echo "==> /metrics snapshot"
curl -fsS "${URL}/metrics" | grep -E "janus_cache_(hits|misses)_total|janus_cache_hit_ratio|janus_requests_total" | tee "${OUT}/metrics.txt"

echo
echo "Raw autocannon JSON saved in ${OUT}/ (cached.json, uncached.json)."
