import { describe, it, expect } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createUsageTap } from '../src/lib/sseUsage.js';

// Pipe SSE text through the tap and collect what a client would receive.
async function run(chunks) {
  const { transform, getUsage } = createUsageTap();
  const out = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      out.push(chunk.toString('utf8'));
      cb();
    },
  });
  await pipeline(Readable.from(chunks), transform, sink);
  return { passedThrough: out.join(''), usage: getUsage() };
}

describe('createUsageTap', () => {
  it('passes bytes through untouched and captures the final usage chunk', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14}}\n\n',
      'data: [DONE]\n\n',
    ];
    const { passedThrough, usage } = await run(chunks);

    // client sees the exact original stream, including [DONE]
    expect(passedThrough).toBe(chunks.join(''));
    expect(usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 3,
      total_tokens: 14,
    });
  });

  it('handles usage split across chunk boundaries', async () => {
    // split a single SSE event mid-JSON to exercise the rolling buffer
    const event =
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n';
    const mid = Math.floor(event.length / 2);
    const { usage } = await run([event.slice(0, mid), event.slice(mid)]);
    expect(usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 2 });
  });

  it('returns null usage when no usage chunk is present', async () => {
    const { usage } = await run([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    expect(usage).toBeNull();
  });
});
