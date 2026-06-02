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

  it('parses comma-separated model lists per provider', () => {
    const [groq] = loadProviders({
      GROQ_API_KEY: 'k',
      GROQ_BASE_URL: 'https://api.groq.com/openai/v1',
      GROQ_MODELS: 'llama-3.1-8b-instant, llama-3.3-70b-versatile ,',
    });
    expect(groq.models).toEqual([
      'llama-3.1-8b-instant',
      'llama-3.3-70b-versatile',
    ]);
  });
});

describe('model-aware routing (getProviderChain with a model)', () => {
  const base = {
    GROQ_API_KEY: 'k',
    GROQ_BASE_URL: 'https://api.groq.com/openai/v1',
    OLLAMA_BASE_URL: 'http://localhost:11434/v1',
  };

  it('routes a model to the only provider that declares it (skips the other)', () => {
    const chain = getProviderChain(
      { ...base, GROQ_MODELS: 'llama-3.1-8b-instant', OLLAMA_MODELS: 'llama3.2' },
      'llama3.2',
    );
    expect(chain.map((p) => p.name)).toEqual(['ollama']);
  });

  it('keeps both providers (fallback order) when both serve the model', () => {
    const chain = getProviderChain(
      { ...base, GROQ_MODELS: 'shared', OLLAMA_MODELS: 'shared' },
      'shared',
    );
    expect(chain.map((p) => p.name)).toEqual(['groq', 'ollama']);
  });

  it('treats a provider with no declared models as a wildcard', () => {
    // groq = wildcard (no GROQ_MODELS), ollama scoped to llama3.2
    const chain = getProviderChain(
      { ...base, OLLAMA_MODELS: 'llama3.2' },
      'some-random-model',
    );
    expect(chain.map((p) => p.name)).toEqual(['groq']);
  });

  it('returns empty when every provider is scoped and none matches', () => {
    const chain = getProviderChain(
      { ...base, GROQ_MODELS: 'a', OLLAMA_MODELS: 'b' },
      'c',
    );
    expect(chain).toEqual([]);
  });
});
