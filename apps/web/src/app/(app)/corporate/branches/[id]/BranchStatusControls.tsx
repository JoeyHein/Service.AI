'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { apiClientFetch } from '../../../../../lib/api.js';

/**
 * Status-toggle button for the branch detail header. active -> paused is
 * the destructive direction and requires the operator to confirm; the API
 * also enforces confirmation: true on its end.
 */
export function BranchStatusControls({
  branchId,
  status,
}: {
  branchId: string;
  status: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toPause() {
    if (status !== 'active') return;
    if (
      typeof window !== 'undefined' &&
      !window.confirm('Pause this branch? All branch-level activity will halt.')
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch(
        `/api/v1/corporate/branches/${branchId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ status: 'paused', confirmation: true }),
        },
      );
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Pause failed');
        return;
      }
      router.refresh();
    });
  }

  function toActive() {
    if (status === 'active') return;
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch(
        `/api/v1/corporate/branches/${branchId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ status: 'active' }),
        },
      );
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Reactivate failed');
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      {status === 'active' ? (
        <button
          type="button"
          onClick={toPause}
          disabled={pending}
          data-testid="branch-status-pause"
          className="rounded border border-amber-300 px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50"
        >
          Pause
        </button>
      ) : (
        <button
          type="button"
          onClick={toActive}
          disabled={pending}
          data-testid="branch-status-activate"
          className="rounded border border-emerald-300 px-3 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-50 disabled:opacity-50"
        >
          Reactivate
        </button>
      )}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}
