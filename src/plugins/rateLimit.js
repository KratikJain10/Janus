import fp from 'fastify-plugin';
import { consumeToken } from '../ratelimit/tokenBucket.js';

/**
 * Decorate fastify with a `rateLimit` preHandler. Must run AFTER authenticate,
 * since the bucket is keyed by request.apiKey. Per-key token bucket, refilled
 * by elapsed time, enforced atomically in Redis.
 */
export default fp(async function rateLimitPlugin(fastify) {
  fastify.decorate('rateLimit', async function rateLimit(request, reply) {
    const key = request.apiKey;
    // why: defensive — if a route wires rateLimit without authenticate first,
    // there's no key to limit on; let it through rather than crash.
    if (!key) return;

    const capacity = key.rate_limit_rpm;
    const refillPerSec = key.rate_limit_rpm / 60;

    let result;
    try {
      result = await consumeToken(fastify.redis, {
        key: `ratelimit:${key.id}`,
        capacity,
        refillPerSec,
        cost: 1,
      });
    } catch (err) {
      // why: fail OPEN — a Redis blip shouldn't take down the gateway. We log
      // it and allow the request rather than reject legitimate traffic.
      request.log.error({ err }, 'rate limit check failed, allowing request');
      return;
    }

    reply.header('x-ratelimit-limit', capacity);
    reply.header('x-ratelimit-remaining', Math.max(0, result.remaining));

    if (!result.allowed) {
      reply.header('retry-after', result.retryAfter);
      return reply.status(429).send({
        error: {
          type: 'rate_limit_exceeded',
          message: `rate limit exceeded, retry in ${result.retryAfter}s`,
        },
      });
    }
  });
});
