import { buildVoiceApp } from './app.js';

/**
 * Entry point for the voice WS server.
 *
 * Reads HOST and PORT from the environment (DigitalOcean App Platform
 * injects these automatically). Registers SIGTERM/SIGINT handlers for
 * graceful shutdown so in-flight WebSocket sessions drain before the
 * process exits.
 */
const app = buildVoiceApp();

const host = process.env.HOST ?? '0.0.0.0';
const port = parseInt(process.env.PORT ?? '8080', 10);

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
