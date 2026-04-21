'use client';

/**
 * App Router error boundary page.
 *
 * Defining this file causes Next.js to use the App Router path for 500
 * responses rather than the legacy Pages Router _error + _document chain.
 * Without it, Next.js 15 tries to statically generate the /500 page via
 * the Pages Router, which loads pages/_document and fails in App Router
 * builds with "Html should not be imported outside of pages/_document".
 *
 * The 'use client' directive is required by Next.js for error boundaries
 * since they rely on React class component error boundary behaviour.
 */
export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <h1 className="text-4xl font-bold">500</h1>
      <p className="mt-4 text-gray-600">Something went wrong</p>
      <button
        className="mt-4 px-4 py-2 bg-blue-600 text-white rounded"
        onClick={() => reset()}
      >
        Try again
      </button>
    </main>
  );
}
