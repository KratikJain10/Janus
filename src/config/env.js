import { z } from 'zod';

// why: validate all config at startup so the process crashes immediately on
// misconfiguration instead of failing deep inside a request later.
const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    // why: defaults point at the local docker-compose services so dev works
    // out of the box; these aren't connected to until later phases.
    REDIS_URL: z.string().url().default('redis://localhost:6379'),
    DATABASE_URL: z
      .string()
      .url()
      .default('postgres://janus:janus@localhost:5432/janus'),
    // why: Groq is the default upstream (free, fast, OpenAI-compatible). The key
    // is optional so the server still boots for /health without it; the chat
    // route reports "no provider configured" at request time when it's missing.
    GROQ_API_KEY: z.string().optional(),
    GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
    // why: optional model-aware routing. Comma-separated model ids this provider
    // serves; empty/unset = wildcard (serves any model). Lets you route a model
    // to a specific provider — and exercise fallback — without taking one offline.
    GROQ_MODELS: z.string().optional(),
    // why: opt-in second provider (local Ollama) for fallback. Unset = Groq only.
    OLLAMA_BASE_URL: z.string().url().optional(),
    OLLAMA_MODELS: z.string().optional(),
    // why: exact-match response cache. Accept a boolean or "true"/"false" string
    // so it works from env vars and from test config alike.
    CACHE_ENABLED: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .default(true)
      .transform((v) => v === true || v === 'true'),
    CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    // why: upstream reliability (Phase 5). Per-attempt timeout, retry count, and a
    // simple per-provider circuit breaker (open after N failures, for a cooldown).
    UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    UPSTREAM_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
    CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().positive().default(5),
    CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15000),
    // why: semantic cache (Phase 7, stretch). Opt-in; needs an embeddings
    // endpoint + the pgvector extension. Threshold is cosine similarity in [0,1].
    SEMANTIC_CACHE_ENABLED: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .default(false)
      .transform((v) => v === true || v === 'true'),
    SEMANTIC_CACHE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.95),
    EMBEDDING_BASE_URL: z.string().url().optional(),
    EMBEDDING_API_KEY: z.string().optional(),
    EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  })
  .superRefine((cfg, ctx) => {
    // why: fail fast — the semantic cache is useless without somewhere to embed.
    if (cfg.SEMANTIC_CACHE_ENABLED && !cfg.EMBEDDING_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMBEDDING_BASE_URL'],
        message: 'is required when SEMANTIC_CACHE_ENABLED=true',
      });
    }
  });

/**
 * Parse and validate process.env. Returns a frozen, typed config object.
 * Throws (and we let it crash the process) when required values are missing
 * or malformed.
 */
export function loadEnv(source = process.env) {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // why: surface every problem at once, but never echo the env values
    // themselves (they may contain secrets).
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return Object.freeze(result.data);
}

export { envSchema };
