/**
 * Provider config is just data: { name, baseUrl, apiKey, models }.
 * Adding a provider later = adding to this list, not writing new call code —
 * the upstream call in providers/openaiCompatible.js is provider-agnostic.
 */
export function loadProviders(config) {
  const providers = [];

  // why: Phase 1 ships a single default provider (Groq). `models: []` is a
  // placeholder until Phase 5 uses it for model-based routing.
  if (config.GROQ_API_KEY) {
    providers.push({
      name: 'groq',
      baseUrl: config.GROQ_BASE_URL,
      apiKey: config.GROQ_API_KEY,
      models: [],
    });
  }

  return providers;
}

/** The provider a request goes to when no routing logic exists yet. */
export function getDefaultProvider(config) {
  return loadProviders(config)[0] ?? null;
}
