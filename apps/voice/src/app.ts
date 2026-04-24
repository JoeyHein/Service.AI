/**
 * Voice service — Fastify app with Twilio Media Streams + AI
 * agent loop (phase_ai_csr_voice).
 *
 * Routes:
 *   GET  /healthz         — liveness
 *   POST /voice/incoming  — Twilio inbound webhook; returns
 *                           TwiML that opens a <Stream> to the
 *                           WS endpoint. Signature-verified.
 *   WS   /voice/stream    — Twilio Media Streams handler; pushes
 *                           frames into the CallOrchestrator.
 *
 * Dependencies are injectable via `buildVoiceApp(opts)` so tests
 * can drive the whole pipeline with stub adapters + a stub AI
 * client without opening any real sockets.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import sensible from '@fastify/sensible';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@service-ai/db';
import { resolveAIClient, type AIClient, type Tool } from '@service-ai/ai';
import {
  stubTelephonyClient,
  type TelephonyClient,
} from './telephony.js';
import { stubAsrClient, type AsrClient } from './asr.js';
import { stubTtsClient, type TtsClient } from './tts.js';
import {
  resolveTenantByToNumber,
  type ResolvedCallTenant,
} from './call-context.js';
import { CallOrchestrator } from './call-orchestrator.js';

const { Pool } = pg;
type Drizzle = NodePgDatabase<typeof schema>;

export interface ToolFactory {
  (opts: {
    db: Drizzle;
    tenant: ResolvedCallTenant;
    conversationId: string;
  }): Record<string, Tool>;
}

export interface VoiceAppOpts {
  db?: Drizzle;
  ai?: AIClient;
  telephony?: TelephonyClient;
  asr?: AsrClient;
  tts?: TtsClient;
  /** Required for the AI CSR agent loop. Defaults to an empty
   *  factory so legacy callers (and the foundation /call echo
   *  route) still work without configuring tools. */
  toolFactory?: ToolFactory;
  gatedTools?: string[];
  logger?: boolean | object;
  publicWsUrl?: string;
}

export function buildVoiceApp(opts: VoiceAppOpts = {}): FastifyInstance {
  const app = Fastify({
    logger:
      opts.logger === undefined
        ? { level: 'info' }
        : (opts.logger as boolean | object),
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: 'x-request-id',
  });

  const db =
    opts.db ??
    drizzle(new Pool({ connectionString: process.env['DATABASE_URL'] }), {
      schema,
    });
  const ai = opts.ai ?? resolveAIClient();
  const telephony = opts.telephony ?? stubTelephonyClient();
  const asr = opts.asr ?? stubAsrClient({});
  const tts = opts.tts ?? stubTtsClient();
  const gatedTools = opts.gatedTools ?? [];
  const toolFactory: ToolFactory =
    opts.toolFactory ?? (() => ({}));

  app.register(sensible);
  app.register(helmet, { contentSecurityPolicy: false });
  app.register(cors);
  app.register(formbody);
  app.register(websocket);

  app.get('/healthz', async () => ({ ok: true }));

  // Legacy echo WS kept from the foundation scaffold so operators
  // can smoke-test connectivity without routing through Twilio.
  app.register(async function (fastify) {
    fastify.get('/call', { websocket: true }, (socket) => {
      socket.on('message', (message: Buffer | string) => {
        const text = message.toString();
        socket.send(text === 'ping' ? 'pong' : text);
      });
    });
  });

  app.post('/voice/incoming', async (req, reply) => {
    const params = (req.body ?? {}) as Record<string, string>;
    const signature =
      (req.headers['x-twilio-signature'] as string | undefined) ?? '';
    const url =
      (req.headers['x-original-url'] as string | undefined) ??
      `https://${req.headers.host}${req.raw.url}`;
    if (!telephony.verifyWebhookSignature({ url, params, signature })) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'BAD_SIGNATURE', message: 'Invalid Twilio signature' },
      });
    }
    const to = params['To'];
    const from = params['From'];
    if (!to || !from) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Missing To/From' },
      });
    }
    const tenant = await resolveTenantByToNumber(db, to);
    if (!tenant) {
      return reply
        .code(200)
        .header('content-type', 'text/xml')
        .send(
          `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say>Sorry, this number is not currently in service. Goodbye.</Say><Hangup/></Response>`,
        );
    }
    const wsBase =
      opts.publicWsUrl ?? `wss://${req.headers.host ?? 'localhost'}`;
    const streamUrl = `${wsBase}/voice/stream`;
    return reply
      .code(200)
      .header('content-type', 'text/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Connect><Stream url="${streamUrl}"><Parameter name="franchiseeId" value="${tenant.franchiseeId}"/><Parameter name="toE164" value="${to}"/><Parameter name="fromE164" value="${from}"/></Stream></Connect></Response>`,
      );
  });

  app.register(async function (fastify) {
    fastify.get('/voice/stream', { websocket: true }, async (socket) => {
      let orchestrator: CallOrchestrator | null = null;
      let streamSid: string | null = null;

      socket.on('message', async (raw: Buffer | string) => {
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        const event = evt.event as string | undefined;
        if (event === 'start') {
          const start = evt.start as Record<string, unknown> | undefined;
          streamSid = (start?.streamSid as string) ?? null;
          const params =
            (start?.customParameters as Record<string, string> | undefined) ?? {};
          const toE164 = params['toE164'];
          const fromE164 = params['fromE164'];
          const callSid = (start?.callSid as string | undefined) ?? streamSid ?? '';
          if (!toE164 || !fromE164) {
            socket.close();
            return;
          }
          const tenant = await resolveTenantByToNumber(db, toE164);
          if (!tenant) {
            socket.close();
            return;
          }
          orchestrator = new CallOrchestrator({
            db,
            ai,
            asr,
            tts,
            buildTools: ({ conversationId, tenant: t }) =>
              toolFactory({ db, tenant: t, conversationId }),
            gatedTools,
            callSid,
            tenant,
            fromE164,
            toE164,
            onTtsFrame: (frame) => {
              socket.send(
                JSON.stringify({
                  event: 'media',
                  streamSid,
                  media: { payload: frame.toString('base64') },
                }),
              );
            },
            onComplete: () => {
              socket.close();
            },
          });
          await orchestrator.start();
          void orchestrator.run();
        } else if (event === 'media') {
          const media = evt.media as { payload: string } | undefined;
          if (!media?.payload || !orchestrator) return;
          const frame = Buffer.from(media.payload, 'base64');
          orchestrator.pushAudio(frame);
        } else if (event === 'stop') {
          orchestrator?.stop();
        }
      });
      socket.on('close', () => {
        orchestrator?.stop();
      });
    });
  });

  return app;
}
