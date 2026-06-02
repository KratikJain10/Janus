/**
 * Provider config is just data: { name, baseUrl, apiKey, models }.
 * Adding a provider later = adding to this list, not writing new call code —
 * the upstream call in providers/openaiCompatible.js is provider-agnostic.
 */
export function loadProviders(config) {
  const providers = [];

  // why: Groq is the primary upstream. `models` declares which models it serves
  // (empty = wildcard); see getProviderChain for how routing uses it.
  if (config.GROQ_API_KEY) {
    providers.push({
      name: 'groq',
      baseUrl: config.GROQ_BASE_URL,
      apiKey: config.GROQ_API_KEY,
      models: parseModels(config.GROQ_MODELS),
    });
  }

  // why: opt-in local fallback (set OLLAMA_BASE_URL). Ollama's OpenAI-compatible
  // API ignores the key, but our caller always sends a Bearer header, so use a
  // harmless placeholder. Order matters: listed after Groq = used as fallback.
  if (config.OLLAMA_BASE_URL) {
    providers.push({
      name: 'ollama',
      baseUrl: config.OLLAMA_BASE_URL,
      apiKey: 'ollama',
      models: parseModels(config.OLLAMA_MODELS),
    });
  }

  return providers;
}

// why: models come from env as a comma-separated string; normalize to a trimmed,
// non-empty array. Unset/blank -> [] which means "serves any model" (wildcard).
function parseModels(csv) {
  if (!csv) return [];
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The provider a request goes to when no routing logic exists yet. */
export function getDefaultProvider(config) {
  return loadProviders(config)[0] ?? null;
}
