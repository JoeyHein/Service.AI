'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../../lib/api.js';

interface ManagerCandidate {
  userId: string;
  name: string | null;
  email: string;
}

/**
 * Assign an existing user (a manager elsewhere in the network) as this
 * branch's manager — POST /api/v1/corporate/branches/:id/managers { userId }.
 * Candidates come from the corporate managers list. To onboard a brand-new
 * person, use "Invite manager" on the Managers page instead.
 */
export function AssignManager({
  branchId,
  hasManager,
}: {
  branchId: string;
  hasManager: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<ManagerCandidate[]>([]);
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const res = await apiClientFetch<ManagerCandidate[]>('/api/v1/corporate/managers');
      if (cancelled) return;
      if (res.status === 200 && res.body.ok && res.body.data) {
        setCandidates(res.body.data);
        setUserId(res.body.data[0]?.userId ?? '');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  function assign() {
    if (!userId) {
      setError('Pick a user to assign.');
      return;
    }
    setError(null);
    start(async () => {
      const res = await apiClientFetch(`/api/v1/corporate/branches/${branchId}/managers`, {
        method: 'POST',
        body: JSON.stringify({ userId }),
      });
      if (res.status !== 200 && res.status !== 201) {
        setError(res.body.error?.message ?? 'Could not assign manager.');
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-blue-300 bg-white px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50"
        data-testid="assign-manager-open"
      >
        {hasManager ? 'Change manager' : 'Assign manager'}
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="block">
        <span className="text-xs text-slate-500">Existing manager</span>
        <select
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          className="mt-1 block min-w-[16rem] rounded border border-slate-300 px-2 py-2 text-sm"
          data-testid="assign-manager-select"
        >
          {candidates.length === 0 && <option value="">No candidates</option>}
          {candidates.map((c) => (
            <option key={c.userId} value={c.userId}>
              {(c.name ?? c.email)} — {c.email}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={assign}
        disabled={pending}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        data-testid="assign-manager-submit"
      >
        {pending ? 'Assigning…' : 'Assign'}
      </button>
      <button
        type="button"
        onClick={() => { setOpen(false); setError(null); }}
        className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600"
      >
        Cancel
      </button>
      {error && <p className="w-full text-xs text-rose-600">{error}</p>}
    </div>
  );
}
