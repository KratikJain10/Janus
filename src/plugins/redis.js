import fp from 'fastify-plugin';
import Redis from 'ioredis';

/**
 * Decorate fastify with a shared ioredis client (fastify.redis).
 *
 * Tests inject a fake via opts.client; otherwise we create a real client and
 * close it on shutdown.
 */
export default fp(async function redisPlugin(fastify, opts) {
  const client =
    opts.client ??
    new Redis(fastify.config.REDIS_URL, {
      // why: defer connecting until first command, so building the app doesn't
      // require Redis to be up (e.g. the /health test).
      lazyConnect: true,
      // why: rate limiting must stay snappy — don't pile up retries on a slow
      // or down Redis; surface the error fast so the limiter can fail open.
      maxRetriesPerRequest: 1,
    });
  fastify.decorate('redis', client);

  fastify.addHook('onClose', async () => {
    // why: disconnect() closes immediately and never throws regardless of
    // connection state (e.g. a lazy client that never connected).
    if (!opts.client) client.disconnect();
  });
});
