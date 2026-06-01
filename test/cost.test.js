import { describe, it, expect } from 'vitest';
import { computeCost } from '../src/usage/cost.js';
import { extractTokens } from '../src/usage/logger.js';

describe('computeCost', () => {
  it('computes cost from token counts for a known model', () => {
    // 1000 in * 0.00005 + 500 out * 0.00008/1k = 0.00005 + 0.00004 = 0.00009
    expect(computeCost('llama-3.1-8b-instant', 1000, 500)).toBeCloseTo(
      0.00009,
      9,
    );
  });

  it('returns null for an unknown model (never guesses)', () => {
    expect(computeCost('mystery-model', 1000, 500)).toBeNull();
  });

  it('returns null when token counts are missing', () => {
    expect(computeCost('llama-3.1-8b-instant', null, null)).toBeNull();
  });
});

describe('extractTokens', () => {
  it('pulls prompt/completion/total from an OpenAI usage block', () => {
    expect(
      extractTokens({
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }),
    ).toEqual({ tokensIn: 10, tokensOut: 4, totalTokens: 14 });
  });

  it('returns nulls when there is no usage block', () => {
    expect(extractTokens({})).toEqual({
      tokensIn: null,
      tokensOut: null,
      totalTokens: null,
    });
  });
});
