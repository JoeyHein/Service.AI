import Link from 'next/link';

/**
 * Placeholder page shown when the app lands someone on a "check your
 * email" flow. Magic-link sign-in is not yet exposed in v1 UI (TASKS.md
 * notes password reset / magic link as v2), so this page just tells the
 * user that the link was sent and points them back to sign-in.
 */
export default function VerifyPage() {
  return (
    <>
      <h2 className="text-xl font-semibold text-slate-900 mb-1">Check your email</h2>
      <p className="text-sm text-slate-500 mb-6">
        We sent you a link. Click it to finish verifying your account.
      </p>
      <Link
        href="/signin"
        className="inline-block w-full text-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
      >
        Back to sign in
      </Link>
    </>
  );
}
