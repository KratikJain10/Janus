import fp from 'fastify-plugin';
import pg from 'pg';

const { Pool } = pg;

/**
 * Decorate fastify with a shared pg Pool (fastify.pg).
 *
 * fastify-plugin un-encapsulates the decorator so sibling plugins/routes see it.
 * Tests inject a fake via opts.pool; in that case we don't own it, so we don't
 * close it on shutdown.
 */
export default fp(async function pgPlugin(fastify, opts) {
  // why: a Pool connects lazily on first query, so building the app (e.g. for
  // the /health test) never opens a socket it doesn't need.
  const pool =
    opts.pool ?? new Pool({ connectionString: fastify.config.DATABASE_URL });
  fastify.decorate('pg', pool);

  fastify.addHook('onClose', async () => {
    if (!opts.pool) await pool.end();
  });
});
