import Fastify from 'fastify';
import pgPlugin from './plugins/pg.js';
import redisPlugin from './plugins/redis.js';
import authPlugin from './plugins/auth.js';
import rateLimitPlugin from './plugins/rateLimit.js';
import healthRoutes from './routes/health.js';
import chatRoutes from './routes/chat.js';

/**
 * Build a configured Fastify instance without starting it.
 * Kept separate from server.js so tests can use fastify.inject() against the
 * same app that production runs.
 *
 * `deps` lets tests inject fakes: { pg, redis }.
 */
export function buildApp(config, deps = {}) {
  const app = Fastify({
    // why: reuse the validated log level and let Fastify wire up pino + the
    // per-request id that we include in structured logs.
    logger: { level: config.LOG_LEVEL },
  });

  // why: expose validated config to routes/plugins as fastify.config so nothing
  // reads process.env directly past startup.
  app.decorate('config', config);

  // why: single, consistent error shape across the whole gateway.
  app.setErrorHandler((err, request, reply) => {
    request.log.error({ err }, 'request failed');
    const statusCode = err.statusCode ?? 500;
    reply.status(statusCode).send({
      error: {
        type: err.code ?? 'internal_error',
        message: statusCode >= 500 ? 'Internal Server Error' : err.message,
      },
    });
  });

  // infra: decorate fastify.pg / fastify.redis (un-encapsulated via fastify-plugin).
  app.register(pgPlugin, { pool: deps.pg });
  app.register(redisPlugin, { client: deps.redis });

  // capabilities: decorate fastify.authenticate / fastify.rateLimit preHandlers.
  app.register(authPlugin);
  app.register(rateLimitPlugin);

  app.register(healthRoutes);
  app.register(chatRoutes);

  return app;
}
