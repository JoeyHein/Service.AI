'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';

type Status =
  | 'unassigned'
  | 'scheduled'
  | 'en_route'
  | 'arrived'
  | 'in_progress'
  | 'completed'
  | 'canceled';

const MATRIX: Record<Status, readonly Status[]> = {
  unassigned: ['scheduled', 'canceled'],
  scheduled: ['en_route', 'unassigned', 'canceled'],
  en_route: ['arrived', 'canceled'],
  arrived: ['in_progress', 'canceled'],
  in_progress: ['completed', 'canceled'],
  completed: [],
  canceled: [],
};

export function JobTransitionPanel({
  jobId,
  status,
}: {
  jobId: string;
  status: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const validTargets = MATRIX[status as Status] ?? [];

  function go(to: Status) {
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch(`/api/v1/jobs/${jobId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ toStatus: to }),
      });
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Transition failed.');
        return;
      }
      router.refresh();
    });
  }

  if (validTargets.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-slate-200 px-4 py-3 text-sm text-slate-500">
        This job is {status}. No further transitions.
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <h2 className="text-sm font-medium text-slate-700">Next steps</h2>
      <div className="mt-3 flex flex-wrap gap-2" data-testid="transition-buttons">
        {validTargets.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => go(t)}
            disabled={pending}
            data-testid={`transition-${t}`}
            className={`rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 ${t === 'canceled' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}
          >
            {t}
          </button>
        ))}
      </div>
      {error && (
        <div
          role="alert"
          className="mt-3 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}
    </div>
  );
}
