/**
 * Sentry initialisation for the Service.AI API process.
 *
 * Sentry is only activated when SENTRY_DSN is present in the environment.
 * In local development and CI without the secret the module is a no-op —
 * no network calls are made and no SDK overhead is incurred.
 *
 * Import this module once at process startup (top of app.ts) so the
 * instrumentation is in place before any request handlers run.
 *
 * Side effects: when SENTRY_DSN is set, Sentry.init patches Node.js globals
 * and begins capturing unhandled exceptions + performance traces.
 *
 * @module sentry
 */

import * as Sentry from '@sentry/node';
import type { FastifyInstance } from 'fastify';

const sentryDsn = process.env['SENTRY_DSN'];

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    tracesSampleRate: 1.0,
    environment: process.env['NODE_ENV'] ?? 'development',
  });
}

/**
 * Wire Sentry's Fastify error handler onto the given app instance so
 * unhandled route errors are captured with request context (URL, method,
 * request ID). No-op when SENTRY_DSN is not set, so local dev and CI
 * without the secret stay side-effect-free.
 */
export function setupFastify(app: FastifyInstance): void {
  if (sentryDsn) {
    Sentry.setupFastifyErrorHandler(app);
  }
}

export { Sentry };
