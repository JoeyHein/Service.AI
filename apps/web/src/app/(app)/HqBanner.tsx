'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import type { ImpersonatingContext } from '../../lib/session.js';

/**
 * Persistent red bar rendered at the top of every (app) route whenever
 * `session.impersonating` is non-null. Clicking "Return to network view"
 * POSTs /impersonate/stop, which clears the server cookie, then refreshes
 * so the next server render picks up the franchisor_admin's native scope.
 */
export function HqBanner({ impersonating }: { impersonating: ImpersonatingContext }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function stop() {
    startTransition(async () => {
      await fetch('/impersonate/stop', { method: 'POST' });
      // Bounce to the franchisor view so the user sees state change clearly.
      router.push('/franchisor/franchisees');
      router.refresh();
    });
  }

  const label =
    impersonating.targetFranchiseeName ?? impersonating.targetFranchiseeId;

  return (
    <div
      data-testid="hq-banner"
      role="alert"
      className="bg-red-600 text-white"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-white animate-pulse" />
          <span>HQ VIEWING: {label}</span>
        </div>
        <button
          type="button"
          onClick={stop}
          disabled={pending}
          className="text-sm font-medium underline hover:no-underline disabled:opacity-60"
        >
          {pending ? 'Returning…' : 'Return to network view'}
        </button>
      </div>
    </div>
  );
}
