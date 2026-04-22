/**
 * Home page — checks API health and renders Service.AI status.
 *
 * Two outbound calls:
 *   1. GET /healthz  — plain fetch for liveness display (gate criterion).
 *   2. POST /api/v1/echo via ts-rest typed client — contract-enforcement
 *      mechanism so any drift in EchoResponseSchema fails at compile time.
 *
 * NEXT_PUBLIC_API_URL controls the base URL; defaults to the standard local
 * dev port. cache: 'no-store' ensures both calls are always live.
 */

import { initClient } from '@ts-rest/core';
import { echoContract } from '@service-ai/contracts';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** ts-rest client — enforces request/response shape against the shared contract. */
const apiClient = initClient(echoContract, {
  baseUrl: BASE_URL,
  baseHeaders: {},
});

/**
 * GET /healthz — plain fetch; returns the parsed JSON body or null on error.
 * This is the primary health signal displayed on the homepage.
 */
async function getHealthStatus(): Promise<{ ok: boolean; db: string; redis: string } | null> {
  try {
    const res = await fetch(`${BASE_URL}/healthz`, { cache: 'no-store' });
    if (res.ok || res.status === 503) {
      return (await res.json()) as { ok: boolean; db: string; redis: string };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * POST /api/v1/echo via ts-rest typed client.
 * TypeScript enforces that result.body.data.echo matches the contract shape;
 * renaming or removing the echo field in EchoResponseSchema breaks the build.
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
  const [health, echo] = await Promise.all([getHealthStatus(), getEchoStatus()]);
  const isOnline = health?.ok === true || echo !== null;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <h1 className="text-4xl font-bold text-blue-600">Service.AI</h1>
      <p className="mt-4 text-gray-600">AI-native field service platform</p>
      <div className="mt-8 p-4 bg-gray-100 rounded">
        <p>API Status: {isOnline ? 'Online' : 'Offline'}</p>
        {health && (
          <p className="text-sm text-gray-500 mt-1">
            DB: {health.db} | Redis: {health.redis}
          </p>
        )}
      </div>
    </main>
  );
}
