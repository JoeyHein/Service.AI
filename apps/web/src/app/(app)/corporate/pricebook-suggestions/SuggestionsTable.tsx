'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';

export interface SuggestionRow {
  id: string;
  branchId: string;
  branchName: string | null;
  serviceItemId: string;
  serviceItemSku: string | null;
  serviceItemName: string | null;
  suggestedPriceCents: number;
  reason: string | null;
  status: string;
  suggestedByUserId: string;
  suggestedByName: string | null;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
}

function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function SuggestionsTable({
  rows,
  actionable,
}: {
  rows: SuggestionRow[];
  actionable: boolean;
}) {
  if (rows.length === 0) {
    return (
      <p className="mt-2 text-sm text-slate-500">No suggestions in this group.</p>
    );
  }
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full text-sm divide-y divide-slate-100">
        <thead>
          <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
            <th className="px-3 py-2">Branch</th>
            <th className="px-3 py-2">Item</th>
            <th className="px-3 py-2 text-right">Suggested</th>
            <th className="px-3 py-2">By</th>
            <th className="px-3 py-2">When</th>
            <th className="px-3 py-2">Reason</th>
            <th className="px-3 py-2 text-right">
              {actionable ? 'Action' : 'Status'}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <Row key={r.id} row={r} actionable={actionable} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ row, actionable }: { row: SuggestionRow; actionable: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function resolve(verb: 'approve' | 'reject') {
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch(
        `/api/v1/corporate/pricebook/suggestions/${row.id}/${verb}`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      if (res.status !== 200) {
        setError(res.body.error?.message ?? `${verb} failed`);
        return;
      }
      router.refresh();
    });
  }

  return (
    <tr>
      <td className="px-3 py-2 text-slate-700">{row.branchName ?? '—'}</td>
      <td className="px-3 py-2 text-slate-700">
        <div className="font-medium">{row.serviceItemName ?? '(unknown)'}</div>
        <div className="text-xs text-slate-500 font-mono">
          {row.serviceItemSku ?? row.serviceItemId}
        </div>
      </td>
      <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-900">
        {formatUsd(row.suggestedPriceCents)}
      </td>
      <td className="px-3 py-2 text-slate-600">
        {row.suggestedByName ?? row.suggestedByUserId}
      </td>
      <td className="px-3 py-2 text-slate-600">{formatDate(row.createdAt)}</td>
      <td className="px-3 py-2 text-slate-600">{row.reason ?? '—'}</td>
      <td className="px-3 py-2 text-right">
        {actionable ? (
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => resolve('approve')}
              className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-60"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => resolve('reject')}
              className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 disabled:opacity-60"
            >
              Reject
            </button>
            {error && (
              <span className="text-xs text-rose-700" role="alert">
                {error}
              </span>
            )}
          </div>
        ) : (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
              row.status === 'approved'
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-slate-100 text-slate-600'
            }`}
          >
            {row.status}
          </span>
        )}
      </td>
    </tr>
  );
}
