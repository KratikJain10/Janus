// Print the headline numbers from an autocannon --json result.
// Usage: node summarize.js <result.json> <label>
import { readFile } from 'node:fs/promises';

const [, , file, label] = process.argv;
const r = JSON.parse(await readFile(file, 'utf8'));

const ms = (v) => (v == null ? 'n/a' : `${v.toFixed(2)} ms`);
const non2xx = r.non2xx ?? 0;
const total = r.requests?.total ?? 0;

console.log(`--- ${label} ---`);
console.log(`requests:        ${total} total, ${non2xx} non-2xx`);
console.log(`throughput:      ${r.requests?.average?.toFixed(1)} req/s avg`);
console.log(`latency mean:    ${ms(r.latency?.mean)}`);
console.log(`latency p90:     ${ms(r.latency?.p90)}`);
console.log(`latency p97.5:   ${ms(r.latency?.p97_5)}`); // autocannon's closest to p95
console.log(`latency p99:     ${ms(r.latency?.p99)}`);
console.log(`latency max:     ${ms(r.latency?.max)}`);
if (non2xx > 0) {
  console.log(`WARNING: ${non2xx} non-2xx responses — results may be skewed.`);
}
