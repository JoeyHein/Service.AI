/**
 * Next.js instrumentation hook for Sentry initialisation.
 *
 * Next.js calls register() once per runtime (nodejs / edge) at startup.
 * Sentry is only activated when SENTRY_DSN is present in the environment —
 * in local development and CI without the secret this function is a no-op.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 * @module instrumentation
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const Sentry = await import('@sentry/nextjs');
    if (process.env.SENTRY_DSN) {
      Sentry.init({
        dsn: process.env.SENTRY_DSN,
        tracesSampleRate: 1.0,
        environment: process.env.NODE_ENV ?? 'development',
      });
    }
  }
}
