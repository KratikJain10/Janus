import { describe, it, expect, vi } from 'vitest';
import {
  buildPromptText,
  embedText,
  findSimilar,
  storeEmbedding,
} from '../src/cache/semanticCache.js';

const embedConfig = {
  EMBEDDING_BASE_URL: 'http://emb/v1',
  EMBEDDING_MODEL: 'text-embedding-3-small',
  EMBEDDING_API_KEY: 'sk-test',
};

describe('semanticCache helpers', () => {
  it('builds prompt text from message roles + content', () => {
    const text = buildPromptText({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi there' },
        { role: 'user', content: [{ type: 'image' }] }, // non-string skipped
      ],
    });
    expect(text).toBe('system: be brief\nuser: hi there');
  });

  it('embedText calls the embeddings endpoint and returns the vector', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    });
    const vec = await embedText('hello', embedConfig, { fetchImpl });
    expect(vec).toEqual([0.1, 0.2, 0.3]);

    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://emb/v1/embeddings');
    expect(opts.headers.authorization).toBe('Bearer sk-test');
    expect(JSON.parse(opts.body)).toEqual({
      model: 'text-embedding-3-small',
      input: 'hello',
    });
  });

  it('embedText throws on a non-2xx embeddings response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
    });
    await expect(embedText('x', embedConfig, { fetchImpl })).rejects.toThrow(
      /embeddings request failed \(500\)/,
    );
  });

  it('findSimilar returns the match when above threshold', async () => {
    const pg = {
      query: vi.fn().mockResolvedValue({
        rows: [{ response: { id: 'cached' }, similarity: '0.97' }],
      }),
    };
    const hit = await findSimilar(pg, {
      provider: 'groq',
      model: 'm',
      embedding: [1, 2, 3],
      threshold: 0.95,
    });
    expect(hit).toEqual({ response: { id: 'cached' }, similarity: 0.97 });
    // embedding is passed as a pgvector literal
    expect(pg.query.mock.calls[0][1][0]).toBe('[1,2,3]');
  });

  it('findSimilar returns null when below threshold', async () => {
    const pg = {
      query: vi.fn().mockResolvedValue({
        rows: [{ response: { id: 'x' }, similarity: '0.80' }],
      }),
    };
    const hit = await findSimilar(pg, {
      provider: 'groq',
      model: 'm',
      embedding: [1],
      threshold: 0.95,
    });
    expect(hit).toBeNull();
  });

  it('findSimilar returns null on no rows', async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    expect(
      await findSimilar(pg, {
        provider: 'g',
        model: 'm',
        embedding: [1],
        threshold: 0.5,
      }),
    ).toBeNull();
  });

  it('storeEmbedding inserts with a vector literal', async () => {
    const pg = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await storeEmbedding(pg, {
      provider: 'groq',
      model: 'm',
      prompt: 'p',
      embedding: [0.5, 0.6],
      response: { id: 'r' },
    });
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toMatch(/insert into semantic_cache/i);
    expect(params).toEqual(['groq', 'm', 'p', '[0.5,0.6]', { id: 'r' }]);
  });
});
