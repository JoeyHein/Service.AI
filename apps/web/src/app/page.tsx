/**
 * Home page — fetches the API health endpoint and renders Service.AI status.
 *
 * Uses the NEXT_PUBLIC_API_URL env var when present; falls back to the
 * standard local dev port. cache: 'no-store' ensures the health check is
 * always live (not cached at the CDN edge).
 */
async function getHealth() {
  try {
    const res = await fetch(
      process.env.NEXT_PUBLIC_API_URL
        ? `${process.env.NEXT_PUBLIC_API_URL}/api/v1/health`
        : 'http://localhost:3001/api/v1/health',
      { cache: 'no-store' }
    );
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export default async function Home() {
  const health = await getHealth();
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
