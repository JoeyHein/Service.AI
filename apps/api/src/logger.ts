/**
 * Pino logger factory for the Service.AI API process.
 *
 * When AXIOM_TOKEN is present in the environment the logger fans out to both
 * the Axiom ingest transport (@axiomhq/pino) and pino-pretty for local
 * console output. When the token is absent (local dev, CI without secrets)
 * only the default pino stderr transport is active — no external calls are made.
 *
 * The redact list intentionally covers every path that might carry an
 * authorization token, session cookie, or bearer credential so that secrets
 * are never written to any log sink.
 *
 * @module logger
 */

import { pino } from 'pino';

const axiomToken = process.env['AXIOM_TOKEN'];

/**
 * Pino multi-transport configuration active only when AXIOM_TOKEN is set.
 * Undefined when the env var is absent so pino uses its built-in default.
 */
const transport = axiomToken
  ? {
      targets: [
        {
          target: '@axiomhq/pino',
          options: {
            dataset: process.env['AXIOM_DATASET'] ?? 'service-ai',
            token: axiomToken,
          },
          level: 'info',
        },
        { target: 'pino-pretty', level: 'info' },
      ],
    }
  : undefined;

/**
 * Shared pino logger instance for the API process.
 *
 * Redacts authorization headers and cookies at every nesting level so they
 * are never emitted to any transport — including Axiom.
 *
 * Side effects: when AXIOM_TOKEN is set, log lines are shipped to Axiom over
 * HTTPS in a background thread managed by pino's worker transport.
 */
export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-service-ai-key"]',
      'res.headers["x-service-ai-key"]',
      '*.authorization',
      'authorization',
      '*.apiKey',
      '*.api_key',
      // SQB-11: BC AI Agent provider auth header. Must never reach
      // Axiom — the key grants commit-quote access for a whole BC
      // customer account.
      '*["x-service-ai-key"]',
      '*.xServiceAiKey',
    ],
    censor: '[REDACTED]',
  },
  ...(transport ? { transport } : {}),
});
