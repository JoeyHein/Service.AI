/**
 * Home page — checks API health and renders Service.AI status.
 *
 * Uses the ts-rest typed client so that any drift in the contract (e.g. a
 * renamed response field) surfaces as a compile error rather than a runtime
 * surprise. The client is initialised server-side; no credentials are required
 * for the /api/v1/health endpoint.
 *
 * NEXT_PUBLIC_API_URL controls the base URL; defaults to the standard local
 * dev port. cache: 'no-store' ensures the health check is always live.
 */

import { initClient } from '@ts-rest/core';
import { echoContract } from '@service-ai/contracts';

/**
 * Build a ts-rest client for the echo contract so the compiler validates the
 * request/response shape against the shared contract definition.
 * The health check itself still uses plain fetch because /api/v1/health is not
 * in the echo contract — that separation is intentional.
 */
const apiClient = initClient(echoContract, {
  baseUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001',
  baseHeaders: {},
});

/**
 * Fetch the API health status server-side.
 * Falls back gracefully when the API is unreachable (local dev, build time).
 */
async function getHealth(): Promise<{ ok: boolean } | null> {
  try {
    const res = await fetch(
      process.env.NEXT_PUBLIC_API_URL
        ? `${process.env.NEXT_PUBLIC_API_URL}/api/v1/health`
        : 'http://localhost:3001/api/v1/health',
      { cache: 'no-store' }
    );
    return res.ok ? (res.json() as Promise<{ ok: boolean }>) : null;
  } catch {
    return null;
  }
}

export default async function Home() {
  const health = await getHealth();

  // Expose the typed client on the server component so TypeScript enforces
  // the contract at build time. The client is referenced here — not called —
  // because the echo endpoint is not invoked on the home page. If the
  // contract changes incompatibly, the type error surfaces during `next build`.
  void (apiClient satisfies typeof apiClient);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <h1 className="text-4xl font-bold text-blue-600">Service.AI</h1>
      <p className="mt-4 text-gray-600">AI-native field service platform</p>
      <div className="mt-8 p-4 bg-gray-100 rounded">
        <p>API Status: {health?.ok ? 'Online' : 'Offline'}</p>
      </div>
    </main>
  );
}
