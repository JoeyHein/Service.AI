'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../../../lib/api.js';

interface Statement {
  id: string;
  periodStart: string;
  periodEnd: string;
  grossRevenue: string;
  refundTotal: string;
  netRevenue: string;
  royaltyOwed: string;
  royaltyCollected: string;
  variance: string;
  status: string;
  transferId: string | null;
}

function money(v: string): string {
  const n = Number(v);
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function periodLabel(start: string): string {
  const d = new Date(start);
  return d.toLocaleString('default', { month: 'long', year: 'numeric' });
}

export function StatementsList({
  franchiseeId,
  initial,
  adminView = false,
}: {
  franchiseeId?: string;
  initial: Statement[];
  adminView?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [month, setMonth] = useState(String(new Date().getMonth() + 1));

  function generate() {
    if (!franchiseeId) return;
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch(
        `/api/v1/franchisees/${franchiseeId}/statements/generate`,
        {
          method: 'POST',
          body: JSON.stringify({ year: Number(year), month: Number(month) }),
        },
      );
      if (res.status !== 201) {
        setError(res.body.error?.message ?? 'Generate failed');
        return;
      }
      router.refresh();
    });
  }

  function reconcile(statementId: string) {
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch(
        `/api/v1/statements/${statementId}/reconcile`,
        { method: 'POST', body: '{}' },
      );
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Reconcile failed');
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="mt-4 space-y-4">
      {adminView && franchiseeId && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-medium text-slate-700">Generate for period</h2>
          <div className="mt-2 flex gap-2 items-center">
            <input
              type="number"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              className="w-24 rounded border border-slate-300 px-2 py-1 text-sm"
              aria-label="Year"
            />
            <input
              type="number"
              min={1}
              max={12}
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="w-16 rounded border border-slate-300 px-2 py-1 text-sm"
              aria-label="Month"
            />
            <button
              type="button"
              onClick={generate}
              disabled={pending}
              data-testid="generate-statement"
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {pending ? 'Working…' : 'Generate'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="text-sm text-red-700">
          {error}
        </div>
      )}

      <div
        data-testid="statements-list"
        className="bg-white rounded-lg border border-slate-200 overflow-hidden"
      >
        {initial.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">
            No statements yet.
          </p>
        ) : (
          <table className="min-w-full text-sm divide-y divide-slate-200">
            <thead className="bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-3 py-2 font-medium">Period</th>
                <th className="px-3 py-2 font-medium text-right">Gross</th>
                <th className="px-3 py-2 font-medium text-right">Refunds</th>
                <th className="px-3 py-2 font-medium text-right">Net</th>
                <th className="px-3 py-2 font-medium text-right">Owed</th>
                <th className="px-3 py-2 font-medium text-right">Collected</th>
                <th className="px-3 py-2 font-medium text-right">Variance</th>
                <th className="px-3 py-2 font-medium">Status</th>
                {adminView && <th className="px-3 py-2 font-medium" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {initial.map((s) => (
                <tr key={s.id}>
                  <td className="px-3 py-2">{periodLabel(s.periodStart)}</td>
                  <td className="px-3 py-2 text-right">{money(s.grossRevenue)}</td>
                  <td className="px-3 py-2 text-right">{money(s.refundTotal)}</td>
                  <td className="px-3 py-2 text-right">{money(s.netRevenue)}</td>
                  <td className="px-3 py-2 text-right">{money(s.royaltyOwed)}</td>
                  <td className="px-3 py-2 text-right">{money(s.royaltyCollected)}</td>
                  <td className="px-3 py-2 text-right">{money(s.variance)}</td>
                  <td className="px-3 py-2 text-xs font-mono">{s.status}</td>
                  {adminView && (
                    <td className="px-3 py-2">
                      {s.status === 'open' ? (
                        <button
                          type="button"
                          onClick={() => reconcile(s.id)}
                          disabled={pending}
                          className="text-xs text-blue-700 hover:underline disabled:opacity-50"
                        >
                          Reconcile
                        </button>
                      ) : (
                        <span className="text-xs text-slate-400">
                          {s.transferId ?? '—'}
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
