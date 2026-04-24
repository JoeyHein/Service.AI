'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { apiClientFetch } from '../../../lib/api.js';

/**
 * One-click "view as <franchisee>" — wraps the phase-2
 * /impersonate/start flow and redirects to /dashboard where
 * the HQ banner picks up automatically.
 */
export function ImpersonateButton({ franchiseeId }: { franchiseeId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  function click() {
    start(async () => {
      const res = await apiClientFetch('/impersonate/start', {
        method: 'POST',
        body: JSON.stringify({ franchiseeId }),
      });
      if (res.status !== 200) return;
      router.push('/dashboard');
      router.refresh();
    });
  }
  return (
    <button
      type="button"
      onClick={click}
      disabled={pending}
      data-testid="impersonate-button"
      className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
    >
      {pending ? '…' : 'View as'}
    </button>
  );
}
