/**
 * Persist one usage row. Caller passes a flat object; we map it to columns.
 * Errors are the caller's to handle (we log-and-continue, never block the
 * client response on a usage write).
 */
export async function logUsage(pg, row) {
  await pg.query(
    `INSERT INTO usage_logs
       (api_key_id, provider, model, tokens_in, tokens_out, total_tokens,
        latency_ms, cost, cached, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      row.apiKeyId,
      row.provider,
      row.model,
      row.tokensIn ?? null,
      row.tokensOut ?? null,
      row.totalTokens ?? null,
      row.latencyMs ?? null,
      row.cost ?? null,
      row.cached ?? false,
      row.status ?? null,
    ],
  );
}

/** Pull token counts out of an OpenAI-shaped response body (usage block). */
export function extractTokens(data) {
  const usage = data?.usage ?? {};
  const tokensIn = usage.prompt_tokens ?? null;
  const tokensOut = usage.completion_tokens ?? null;
  const totalTokens =
    usage.total_tokens ??
    (tokensIn != null && tokensOut != null ? tokensIn + tokensOut : null);
  return { tokensIn, tokensOut, totalTokens };
}
