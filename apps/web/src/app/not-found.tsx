/**
 * App Router 404 not-found page.
 *
 * Defining this file causes Next.js to use the App Router path for 404
 * responses rather than the legacy Pages Router _error + _document chain.
 * Without it, Next.js 15 tries to statically generate the /404 page via
 * the Pages Router, which loads pages/_document and fails in App Router
 * builds with "Html should not be imported outside of pages/_document".
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="mt-4 text-gray-600">Page not found</p>
    </main>
  );
}
