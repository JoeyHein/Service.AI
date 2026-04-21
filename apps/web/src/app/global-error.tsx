'use client';

/**
 * Root-level error boundary for React render errors in the App Router.
 *
 * Next.js requires this file to report React rendering errors to Sentry.
 * Without it, crashes inside Server Components or the root layout itself
 * are not forwarded to Sentry because the normal error.tsx boundary only
 * catches errors thrown below the root layout, not inside it.
 *
 * Unlike error.tsx, global-error.tsx replaces the entire document — so
 * it must render its own <html> and <body> tags. The 'use client' directive
 * is required because Next.js error boundaries depend on React class
 * component error boundary behaviour.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error#global-errorjs
 */

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Report to Sentry when a render error reaches this boundary.
    // Sentry.init() runs via instrumentation.ts — captureException is
    // a no-op when the DSN is absent (local dev).
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main
          style={{
            display: 'flex',
            minHeight: '100vh',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '6rem',
            fontFamily: 'sans-serif',
          }}
        >
          <h1 style={{ fontSize: '2.25rem', fontWeight: 700 }}>500</h1>
          <p style={{ marginTop: '1rem', color: '#4b5563' }}>
            Something went wrong
          </p>
          <button
            style={{
              marginTop: '1rem',
              padding: '0.5rem 1rem',
              backgroundColor: '#2563eb',
              color: '#fff',
              borderRadius: '0.25rem',
              border: 'none',
              cursor: 'pointer',
            }}
            onClick={() => reset()}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
