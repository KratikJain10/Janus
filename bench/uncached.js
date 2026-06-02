// Uncached-path load test: every request carries a unique prompt, so it always
// misses the exact-match cache and is forwarded upstream to Groq.
//
// why a hand-rolled driver (not autocannon): autocannon's --idReplacement leaves
// a stale Content-Length, and its setupRequest warms connections with an empty
// body (-> 400s). For the upstream path we make few, real calls, so a small
// fixed-concurrency fetch loop gives clean, defensible latency/throughput.
//
// Usage: BENCH_KEY=jns_... node bench/uncached.js
import { performance } from 'node:perf_hooks';

const URL = process.env.URL || 'http://localhost:3000';
const MODEL = process.env.MODEL || 'llama-3.1-8b-instant';
const CONC = Number(process.env.MISS_C || 4); // keep modest: Groq free tier
const TOTAL = Number(process.env.MISS_A || 40); // this many REAL Groq calls
const DELAY = Number(process.env.MISS_DELAY || 0); // ms between calls per worker (stay under Groq TPM)
const KEY = process.env.BENCH_KEY;
if (!KEY) throw new Error('set BENCH_KEY to a Janus client key (jns_...)');

const headers = {
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

async function oneCall(i) {
  const body = JSON.stringify({
    model: MODEL,
    messages: [
      { role: 'user', content: `Give me one fact about the number ${i}-${Date.now()}.` },
    ],
    temperature: 0,
  });
  const t0 = performance.now();
  const res = await fetch(`${URL}/v1/chat/completions`, { method: 'POST', headers, body });
  await res.text(); // drain
  return { ms: performance.now() - t0, ok: res.ok, status: res.status, cache: res.headers.get('x-cache') };
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function main() {
  const lat = [];
  let ok = 0;
  let bad = 0;
  let next = 0;
  const wall0 = performance.now();
  // fixed-size worker pool of CONC promises pulling from a shared counter
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= TOTAL) return;
      try {
        const r = await oneCall(i);
        if (r.ok && r.cache !== 'HIT') {
          ok++;
          lat.push(r.ms);
        } else {
          bad++;
        }
      } catch {
        bad++;
      }
      if (DELAY) await new Promise((r) => setTimeout(r, DELAY));
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  const wallSec = (performance.now() - wall0) / 1000;

  lat.sort((a, b) => a - b);
  const ms = (v) => (v == null ? 'n/a' : `${v.toFixed(0)} ms`);
  const mean = lat.reduce((a, b) => a + b, 0) / (lat.length || 1);
  console.log('--- UNCACHED (-> Groq) ---');
  console.log(`concurrency:     ${CONC}`);
  console.log(`requests:        ${ok} ok (MISS), ${bad} failed/non-miss`);
  console.log(`throughput:      ${(ok / wallSec).toFixed(1)} req/s (wall ${wallSec.toFixed(1)}s)`);
  console.log(`latency mean:    ${ms(mean)}`);
  console.log(`latency p50:     ${ms(pct(lat, 50))}`);
  console.log(`latency p95:     ${ms(pct(lat, 95))}`);
  console.log(`latency p99:     ${ms(pct(lat, 99))}`);
  console.log(`latency max:     ${ms(lat[lat.length - 1])}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
