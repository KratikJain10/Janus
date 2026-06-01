/**
 * Call an OpenAI-compatible Chat Completions endpoint (non-streaming).
 *
 * Returns { status, data }: the upstream HTTP status and parsed JSON body,
 * passed through transparently so OpenAI-shaped success and error payloads
 * reach the client intact. Streaming, timeouts, retries and fallback are
 * deliberately left to later phases.
 *
 * `fetchImpl` is injectable so tests can stub the network without globals.
 */
export async function chatCompletion(
  provider,
  body,
  { fetchImpl = globalThis.fetch } = {},
) {
  // why: tolerate a trailing slash in configured baseUrl.
  const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // why: the upstream key is attached here and nowhere else — it never
      // appears in responses, logs, or errors returned to the client.
      authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  // why: some upstream errors return non-JSON (HTML/plain text). Read as text
  // first and parse defensively so a bad body can't crash the gateway.
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      error: {
        type: 'upstream_error',
        message: text.slice(0, 500),
      },
    };
  }

  return { status: res.status, data };
}

/**
 * Start a streaming Chat Completions request. Returns the raw fetch Response
 * WITHOUT consuming the body, so the caller can pipe `res.body` straight to the
 * client (no buffering). The caller inspects `res.ok`/`res.status` first: a
 * non-2xx upstream returns a JSON error here, not an SSE stream.
 *
 * `signal` lets the caller abort the upstream when the client disconnects.
 */
export async function chatCompletionStream(
  provider,
  body,
  { fetchImpl = globalThis.fetch, signal } = {},
) {
  const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;

  return fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      // why: upstream key attached only on the outbound request.
      authorization: `Bearer ${provider.apiKey}`,
    },
    // why: body already carries stream:true from the validated request.
    body: JSON.stringify(body),
    signal,
  });
}
