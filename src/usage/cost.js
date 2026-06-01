// Per-model prices in USD per 1,000 tokens. Approximate published rates; keep
// this table updated as providers change pricing. Unknown models cost null
// (we report "unknown" rather than guess and mislead).
//
// why: a plain table keeps cost logic auditable and easy to explain.
const PRICES = {
  // Groq
  'llama-3.1-8b-instant': { inputPer1k: 0.00005, outputPer1k: 0.00008 },
  'llama-3.3-70b-versatile': { inputPer1k: 0.00059, outputPer1k: 0.00079 },
  // OpenAI
  'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  'gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01 },
};

/**
 * Compute request cost from the response token counts.
 * Returns null for unknown models or missing token counts (rather than 0/guess),
 * so callers can distinguish "free" from "unknown".
 */
export function computeCost(model, tokensIn, tokensOut) {
  const price = PRICES[model];
  if (!price) return null;
  if (tokensIn == null || tokensOut == null) return null;
  const cost =
    (tokensIn / 1000) * price.inputPer1k +
    (tokensOut / 1000) * price.outputPer1k;
  // why: round to the column's 6-decimal precision to avoid float noise.
  return Number(cost.toFixed(6));
}

export { PRICES };
