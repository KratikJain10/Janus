/**
 * GET /v1/usage — per-key usage + cost summary. Authenticated: a key sees only
 * its own usage (the resolved request.apiKey).
 */
export default async function usageRoutes(fastify) {
  fastify.get(
    '/v1/usage',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const keyId = request.apiKey.id;

      const totalsResult = await fastify.pg.query(
        `SELECT count(*)::int                              AS requests,
                coalesce(sum(tokens_in), 0)::int           AS tokens_in,
                coalesce(sum(tokens_out), 0)::int          AS tokens_out,
                coalesce(sum(cost), 0)::numeric            AS cost,
                count(*) FILTER (WHERE cached)::int        AS cache_hits
           FROM usage_logs
          WHERE api_key_id = $1`,
        [keyId],
      );

      const byModelResult = await fastify.pg.query(
        `SELECT model,
                count(*)::int                     AS requests,
                coalesce(sum(tokens_in), 0)::int  AS tokens_in,
                coalesce(sum(tokens_out), 0)::int AS tokens_out,
                coalesce(sum(cost), 0)::numeric   AS cost
           FROM usage_logs
          WHERE api_key_id = $1
          GROUP BY model
          ORDER BY requests DESC`,
        [keyId],
      );

      const totals = totalsResult.rows[0];
      return {
        key_id: keyId,
        name: request.apiKey.name,
        totals: {
          requests: totals.requests,
          tokens_in: totals.tokens_in,
          tokens_out: totals.tokens_out,
          // why: pg returns numeric as a string — coerce to a JSON number.
          cost: Number(totals.cost),
          cache_hits: totals.cache_hits,
        },
        by_model: byModelResult.rows.map((r) => ({
          model: r.model,
          requests: r.requests,
          tokens_in: r.tokens_in,
          tokens_out: r.tokens_out,
          cost: Number(r.cost),
        })),
      };
    },
  );
}
