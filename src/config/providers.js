/**
 * Provider config is just data: { name, baseUrl, apiKey, models }.
 * Adding a provider later = adding to this list, not writing new call code —
 * the upstream call in providers/openaiCompatible.js is provider-agnostic.
 */
export function loadProviders(config) {
  const providers = [];

  // why: Groq is the primary upstream. `models: []` is a placeholder for
  // model-aware routing (a later refinement).
  if (config.GROQ_API_KEY) {
    providers.push({
      name: 'groq',
      baseUrl: config.GROQ_BASE_URL,
      apiKey: config.GROQ_API_KEY,
      models: [],
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
      models: [],
    });
  }

  return providers;
}

/** The provider a request goes to when no routing logic exists yet. */
export function getDefaultProvider(config) {
  return loadProviders(config)[0] ?? null;
}
