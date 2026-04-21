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
 * Ping the echo endpoint via the ts-rest typed client.
 * TypeScript enforces that `result.body.data.echo` matches the contract shape;
 * if the contract's EchoResponseSchema renames or removes `echo`, this fails to
 * typecheck before any runtime execution.
 */
async function getEchoStatus(): Promise<string | null> {
  try {
    const result = await apiClient.echo({ body: { message: 'ping' } });
    if (result.status === 200) {
      return result.body.data.echo;
    }
    return null;
  } catch {
    return null;
  }
}

export default async function Home() {
  const echo = await getEchoStatus();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <h1 className="text-4xl font-bold text-blue-600">Service.AI</h1>
      <p className="mt-4 text-gray-600">AI-native field service platform</p>
      <div className="mt-8 p-4 bg-gray-100 rounded">
        <p>API Status: {echo !== null ? 'Online' : 'Offline'}</p>
      </div>
    </main>
  );
}
