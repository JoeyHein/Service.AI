'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { apiClientFetch } from '../../../lib/api.js';

interface Suggestion {
  id: string;
  subjectJobId: string;
  proposedTechUserId: string | null;
  proposedScheduledStart: string | null;
  reasoning: string;
  confidence: string;
  status: string;
}

interface Tech {
  userId: string;
  name: string | null;
}

/**
 * Right-side panel on the dispatch board that surfaces the AI
 * dispatcher's pending suggestions. One-click approve / reject
 * + a "Suggest" button that triggers a fresh run.
 */
export function AiSuggestionsPanel({
  initial,
  techsById,
}: {
  initial: Suggestion[];
  techsById: Record<string, string>;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Suggestion[]>(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function trigger() {
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch<{
        proposals: number;
        autoApplied: number;
        queued: number;
      }>('/api/v1/dispatch/suggest', {
        method: 'POST',
        body: '{}',
      });
      if (res.status !== 201) {
        setError(res.body.error?.message ?? 'Suggest failed');
        return;
      }
      router.refresh();
    });
  }

  function approve(id: string) {
    setError(null);
    setRows((prev) => prev.filter((r) => r.id !== id)); // optimistic
    startTransition(async () => {
      const res = await apiClientFetch(
        `/api/v1/dispatch/suggestions/${id}/approve`,
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
    setRows((prev) => prev.filter((r) => r.id !== id)); // optimistic
    startTransition(async () => {
      const res = await apiClientFetch(
        `/api/v1/dispatch/suggestions/${id}/reject`,
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

  function techLabel(userId: string | null): string {
    if (!userId) return 'unassigned';
    return techsById[userId] ?? userId.slice(0, 8);
  }

  return (
    <aside
      data-testid="ai-suggestions-panel"
      className="w-72 shrink-0 rounded-lg border border-slate-200 bg-white"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200">
        <h2 className="text-sm font-semibold text-slate-800">AI suggestions</h2>
        <button
          type="button"
          onClick={trigger}
          disabled={pending}
          data-testid="trigger-suggest"
          className="rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? 'Working…' : 'Suggest'}
        </button>
      </div>
      {error && (
        <div role="alert" className="px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}
      <ul className="divide-y divide-slate-100 max-h-[70vh] overflow-auto">
        {rows.length === 0 ? (
          <li className="px-3 py-4 text-sm text-slate-500">
            No pending suggestions.
          </li>
        ) : (
          rows.map((r) => (
            <li key={r.id} className="px-3 py-3 space-y-2 text-sm">
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs font-mono text-slate-500">
                  {techLabel(r.proposedTechUserId)}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-slate-400">
                  {(Number(r.confidence) * 100).toFixed(0)}%
                </span>
              </div>
              <p className="text-slate-700">{r.reasoning}</p>
              {r.proposedScheduledStart && (
                <p className="text-xs text-slate-500">
                  {new Date(r.proposedScheduledStart).toLocaleString()}
                </p>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => approve(r.id)}
                  disabled={pending}
                  data-testid="approve-suggestion"
                  className="rounded-md bg-green-600 px-2 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => reject(r.id)}
                  disabled={pending}
                  data-testid="reject-suggestion"
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </li>
          ))
        )}
      </ul>
    </aside>
  );
}
