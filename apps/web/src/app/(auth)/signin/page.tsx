import { Suspense } from 'react';
import { SignInForm } from './SignInForm';

/**
 * Server wrapper — Next.js 15 requires a Suspense boundary around any
 * client subtree that calls useSearchParams() so the page can still be
 * statically optimized when no query string is present.
 */
export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}
