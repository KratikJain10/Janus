import { fetchWithRetry } from '../lib/http.js';

/**
 * Build the text to embed from the chat messages. We join "role: content" so
 * semantically similar conversations (not just identical strings) match.
 * Non-string content (e.g. vision parts) is skipped.
 */
export function buildPromptText(body) {
  return (body.messages ?? [])
    .filter((m) => typeof m.content === 'string')
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
}

/**
 * Embed text via an OpenAI-compatible /embeddings endpoint. Returns the vector
 * (number[]). `opts` (timeoutMs/retries/log) flow into fetchWithRetry.
 */
export async function embedText(text, config, opts = {}) {
  const url = `${config.EMBEDDING_BASE_URL.replace(/\/$/, '')}/embeddings`;
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.EMBEDDING_API_KEY
          ? { authorization: `Bearer ${config.EMBEDDING_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({ model: config.EMBEDDING_MODEL, input: text }),
    },
    opts,
  );

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(
      `embeddings request failed (${res.status}): ${detail.slice(0, 200)}`,
    );
  }
  const data = await res.json();
  const vector = data?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) {
    throw new Error('embeddings response missing an embedding vector');
  }
  return vector;
}

// pgvector accepts a text literal like "[0.1,0.2,0.3]".
function toVectorLiteral(vector) {
  return `[${vector.join(',')}]`;
}

/**
 * Nearest cached prompt for (provider, model) by cosine distance (`<=>`).
 * Returns { response, similarity } when the best match meets `threshold`,
 * else null. similarity = 1 - cosine_distance.
 */
export async function findSimilar(
  pg,
  { provider, model, embedding, threshold },
) {
  const { rows } = await pg.query(
    `SELECT response, 1 - (embedding <=> $1::vector) AS similarity
       FROM semantic_cache
      WHERE provider = $2 AND model = $3
      ORDER BY embedding <=> $1::vector
      LIMIT 1`,
    [toVectorLiteral(embedding), provider, model],
  );
  if (rows.length === 0) return null;
  const similarity = Number(rows[0].similarity);
  if (similarity < threshold) return null;
  return { response: rows[0].response, similarity };
}

/** Store a prompt's embedding + response for future similarity lookups. */
export async function storeEmbedding(
  pg,
  { provider, model, prompt, embedding, response },
) {
  await pg.query(
    `INSERT INTO semantic_cache (provider, model, prompt, embedding, response)
     VALUES ($1, $2, $3, $4::vector, $5)`,
    [provider, model, prompt, toVectorLiteral(embedding), response],
  );
}
