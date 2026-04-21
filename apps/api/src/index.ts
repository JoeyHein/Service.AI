/**
 * Entry point for the Service.AI Fastify API server.
 *
 * Reads HOST / PORT from environment, starts the server, and registers
 * graceful-shutdown handlers for SIGTERM and SIGINT so in-flight requests
 * drain before the process exits.
 *
 * @module index
 */

import { buildApp } from './app.js';

const app = buildApp();

const host = process.env['HOST'] ?? '0.0.0.0';
const port = parseInt(process.env['PORT'] ?? '3001', 10);

const signals = ['SIGTERM', 'SIGINT'] as const;

for (const signal of signals) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

try {
  await app.listen({ host, port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
