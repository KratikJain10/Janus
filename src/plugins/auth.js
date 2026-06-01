import fp from 'fastify-plugin';
import { sha256 } from '../lib/hash.js';

/**
 * Decorate fastify with an `authenticate` preHandler. Routes opt in via
 * { preHandler: [fastify.authenticate, ...] }, so public routes (e.g. /health)
 * stay open.
 *
 * On success it attaches the key row to request.apiKey for downstream hooks
 * (rate limiting now, usage logging later).
 */
export default fp(async function authPlugin(fastify) {
  // why: pre-declare the property so Fastify keeps a stable request shape (V8).
  fastify.decorateRequest('apiKey', null);

  fastify.decorate('authenticate', async function authenticate(request, reply) {
    const token = extractToken(request);
    if (!token) {
      return reply.status(401).send({
        error: { type: 'authentication_error', message: 'missing API key' },
      });
    }

    let rows;
    try {
      // why: look up by hash — the plaintext key is never stored.
      ({ rows } = await fastify.pg.query(
        `SELECT id, name, rate_limit_rpm
           FROM api_keys
          WHERE key_hash = $1 AND revoked_at IS NULL`,
        [sha256(token)],
      ));
    } catch (err) {
      request.log.error({ err }, 'auth lookup failed');
      return reply.status(500).send({
        error: { type: 'internal_error', message: 'Internal Server Error' },
      });
    }

    if (rows.length === 0) {
      // why: same response for unknown vs revoked — don't leak which.
      return reply.status(401).send({
        error: { type: 'authentication_error', message: 'invalid API key' },
      });
    }

    request.apiKey = rows[0];
  });
});

// Accept the OpenAI-style "Authorization: Bearer <key>" or an x-api-key header.
function extractToken(request) {
  const header = request.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  const apiKeyHeader = request.headers['x-api-key'];
  return typeof apiKeyHeader === 'string' ? apiKeyHeader.trim() : null;
}
