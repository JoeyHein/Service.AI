import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import sensible from '@fastify/sensible';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';

/**
 * Builds and configures the Fastify voice server instance.
 *
 * Sets up WebSocket support via @fastify/websocket and security plugins.
 * Exposes two routes:
 * - GET /healthz — returns { ok: true } for liveness probes
 * - WS  /call   — echoes every message; replies "pong" for "ping"
 *
 * This is the foundation stub (TASK-FND-05). Twilio Media Streams, Deepgram,
 * and ElevenLabs integrations are added in phase_ai_csr_voice.
 *
 * @returns Configured but not-yet-listening Fastify instance.
 */
export function buildVoiceApp() {
  const app = Fastify({
    logger: { level: 'info' },
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: 'x-request-id',
  });

  app.register(sensible);
  app.register(helmet, { contentSecurityPolicy: false });
  app.register(cors);
  app.register(websocket);

  app.get('/healthz', async () => {
    return { ok: true };
  });

  app.register(async function (fastify) {
    fastify.get('/call', { websocket: true }, (socket) => {
      socket.on('message', (message: Buffer | string) => {
        const text = message.toString();
        if (text === 'ping') {
          socket.send('pong');
        } else {
          socket.send(text); // echo anything else
        }
      });
    });
  });

  return app;
}
