-- Semantic (near-duplicate) response cache. Requires the pgvector extension.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS semantic_cache (
  id         bigserial PRIMARY KEY,
  -- namespaced like the exact cache so prompts don't cross providers/models.
  provider   text NOT NULL,
  model      text NOT NULL,
  prompt     text NOT NULL,
  -- why: unsized `vector` so the embedding model (and its dimension) stays a
  -- config choice. For large datasets, pin the dimension and add an HNSW index
  -- (CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)).
  embedding  vector NOT NULL,
  response   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- why: similarity search filters by provider+model first, then scans vectors.
CREATE INDEX IF NOT EXISTS semantic_cache_provider_model_idx
  ON semantic_cache (provider, model);
