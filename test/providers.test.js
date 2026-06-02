import { describe, it, expect } from 'vitest';
import { loadProviders } from '../src/config/providers.js';
import { getProviderChain } from '../src/providers/router.js';

describe('provider config', () => {
  it('loads only Groq by default', () => {
    const providers = loadProviders({
      GROQ_API_KEY: 'k',
      GROQ_BASE_URL: 'https://api.groq.com/openai/v1',
    });
    expect(providers.map((p) => p.name)).toEqual(['groq']);
  });

  it('adds Ollama as a fallback after Groq when OLLAMA_BASE_URL is set', () => {
    const chain = getProviderChain({
      GROQ_API_KEY: 'k',
      GROQ_BASE_URL: 'https://api.groq.com/openai/v1',
      OLLAMA_BASE_URL: 'http://localhost:11434/v1',
    });
    // order matters: Groq primary, Ollama fallback
    expect(chain.map((p) => p.name)).toEqual(['groq', 'ollama']);
    expect(chain[1]).toMatchObject({
      name: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
    });
  });

  it('returns an empty chain when nothing is configured', () => {
    expect(getProviderChain({})).toEqual([]);
  });
});
