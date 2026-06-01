import { metrics } from '../lib/metrics.js';

/**
 * GET /metrics — Prometheus exposition format. Public (unauthenticated), as
 * scrapers expect, and dependency-free so it answers even if pg/redis are down.
 */
export default async function metricsRoutes(fastify) {
  fastify.get('/metrics', async (request, reply) => {
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return metrics.render();
  });
}
