import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';

// why: validate env before anything else so we fail fast on bad config.
const config = loadEnv();

const app = buildApp(config);

async function start() {
  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (err) {
    app.log.error(err, 'failed to start server');
    process.exit(1);
  }
}

// why: graceful shutdown so in-flight requests and connections close cleanly.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    app.log.info(`received ${signal}, shutting down`);
    await app.close();
    process.exit(0);
  });
}

start();
