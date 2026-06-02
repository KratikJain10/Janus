import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * GET /dashboard — a minimal, no-build React page (React via CDN) that reads
 * /v1/usage and /metrics. Public; the page itself prompts for an API key to
 * fetch per-key usage.
 */
export default async function dashboardRoutes(fastify) {
  const file = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'public',
    'dashboard.html',
  );
  // why: read once at startup — the page is static, no need to hit disk per request.
  const page = await readFile(file, 'utf8');

  fastify.get('/dashboard', async (request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return page;
  });
}
