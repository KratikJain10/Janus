import { Transform } from 'node:stream';

/**
 * Tap an OpenAI-compatible SSE stream for exact usage accounting.
 *
 * Returns a passthrough Transform that forwards every byte to the client
 * UNCHANGED while side-scanning `data:` lines for a usage object. OpenAI-style
 * upstreams emit a final chunk carrying `usage` when the request includes
 * `stream_options: { include_usage: true }`; we keep the last one we see.
 *
 * why a tap (not buffering): we must never delay or alter the stream the client
 * receives, and we must not hold the whole response in memory — so we push each
 * chunk straight through and only retain a small rolling buffer for the parser.
 */
export function createUsageTap() {
  let buffer = '';
  let usage = null;

  const transform = new Transform({
    transform(chunk, _enc, cb) {
      // why: forward first so client latency is untouched by our parsing.
      this.push(chunk);

      buffer += chunk.toString('utf8');
      // SSE events are separated by a blank line; process only complete events
      // and keep the trailing partial in `buffer`.
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of event.split('\n')) {
          const trimmed = line.trimStart();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '' || payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            // why: only the usage chunk carries token counts; ignore token deltas.
            if (json?.usage && json.usage.prompt_tokens != null) {
              usage = json.usage;
            }
          } catch {
            // why: a non-JSON or partial payload is not fatal — skip it.
          }
        }
      }
      cb();
    },
  });

  return { transform, getUsage: () => usage };
}
