/**
 * Liveness endpoint. Kept dependency-free so it answers even when Redis or
 * Postgres are down — readiness/health of those comes in later phases.
 */
export default async function healthRoutes(fastify) {
  fastify.get('/health', async () => {
    return { status: 'ok', uptime: process.uptime() };
  });
}
