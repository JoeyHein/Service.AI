'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../lib/api.js';

interface Draft {
  id: string;
  invoiceId: string;
  tone: 'friendly' | 'firm' | 'final';
  status: string;
  smsBody: string;
  emailSubject: string;
  emailBody: string;
  createdAt: string;
}

function toneColor(tone: Draft['tone']): string {
  switch (tone) {
    case 'friendly':
      return 'bg-green-100 text-green-800';
    case 'firm':
      return 'bg-amber-100 text-amber-800';
    case 'final':
      return 'bg-red-100 text-red-800';
  }
}

export function CollectionsQueue({ initial }: { initial: Draft[] }) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Draft[]>(initial);
  const [editing, setEditing] = useState<Record<string, Partial<Draft>>>({});
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sweepPending, startSweep] = useTransition();

  function sweep() {
    setError(null);
    startSweep(async () => {
      const res = await apiClientFetch<{ drafted: number; inspected: number }>(
        '/api/v1/collections/run',
        { method: 'POST', body: '{}' },
      );
      if (res.status !== 201) {
        setError(res.body.error?.message ?? 'Sweep failed');
        return;
      }
      router.refresh();
    });
  }

  function approve(id: string) {
    setError(null);
    setDrafts((prev) => prev.filter((d) => d.id !== id));
    startTransition(async () => {
      const res = await apiClientFetch(
        `/api/v1/collections/drafts/${id}/approve`,
        { method: 'POST', body: '{}' },
      );
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Approve failed');
        router.refresh();
        return;
      }
      router.refresh();
    });
  }

  function reject(id: string) {
    setError(null);
    setDrafts((prev) => prev.filter((d) => d.id !== id));
    startTransition(async () => {
      const res = await apiClientFetch(
        `/api/v1/collections/drafts/${id}/reject`,
        { method: 'POST', body: '{}' },
      );
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Reject failed');
        router.refresh();
        return;
      }
      router.refresh();
    });
  }

  function saveEdit(id: string) {
    const edits = editing[id];
    if (!edits) return;
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch<Draft>(
        `/api/v1/collections/drafts/${id}/edit`,
        { method: 'POST', body: JSON.stringify(edits) },
      );
      if (res.status !== 200 || !res.body.data) {
        setError(res.body.error?.message ?? 'Edit failed');
        return;
      }
      setDrafts((prev) =>
        prev.map((d) => (d.id === id ? { ...d, ...res.body.data! } : d)),
      );
      setEditing((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    });
  }

  return (
    <div className="space-y-3" data-testid="collections-queue">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          {drafts.length === 0
            ? 'No pending drafts.'
            : `${drafts.length} pending ${drafts.length === 1 ? 'draft' : 'drafts'}`}
        </p>
        <button
          type="button"
          onClick={sweep}
          disabled={sweepPending}
          data-testid="collections-sweep"
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {sweepPending ? 'Working…' : 'Run sweep'}
        </button>
      </div>
      {error && (
        <div role="alert" className="text-sm text-red-700">
          {error}
        </div>
      )}
      <ul className="space-y-3">
        {drafts.map((d) => {
          const edit = editing[d.id];
          return (
            <li
              key={d.id}
              className="rounded-lg border border-slate-200 bg-white p-4 space-y-2"
            >
              <div className="flex items-start justify-between">
                <span
                  className={`text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded ${toneColor(d.tone)}`}
                >
                  {d.tone}
                </span>
                <span className="text-xs text-slate-500 font-mono">
                  {d.invoiceId.slice(0, 8)}
                </span>
              </div>

              <div>
                <label className="block text-xs text-slate-500">SMS</label>
                <textarea
                  rows={2}
                  defaultValue={d.smsBody}
                  onChange={(e) =>
                    setEditing((prev) => ({
                      ...prev,
                      [d.id]: { ...prev[d.id], smsBody: e.target.value },
                    }))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-500">Email subject</label>
                <input
                  type="text"
                  defaultValue={d.emailSubject}
                  onChange={(e) =>
                    setEditing((prev) => ({
                      ...prev,
                      [d.id]: { ...prev[d.id], emailSubject: e.target.value },
                    }))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-500">Email body</label>
                <textarea
                  rows={4}
                  defaultValue={d.emailBody}
                  onChange={(e) =>
                    setEditing((prev) => ({
                      ...prev,
                      [d.id]: { ...prev[d.id], emailBody: e.target.value },
                    }))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </div>

              <div className="flex gap-2 justify-end">
                {edit && (
                  <button
                    type="button"
                    onClick={() => saveEdit(d.id)}
                    disabled={pending}
                    className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    Save edits
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => approve(d.id)}
                  disabled={pending}
                  data-testid="collections-approve"
                  className="rounded-md bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  Approve + send
                </button>
                <button
                  type="button"
                  onClick={() => reject(d.id)}
                  disabled={pending}
                  data-testid="collections-reject"
                  className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
