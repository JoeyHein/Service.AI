'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';

export interface POLine {
  id: string;
  sku: string;
  description: string | null;
  quantity: string;
  receivedQty: string;
  unitCostCents: number;
}

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'CAD' });
}

export function PurchaseOrderActions({
  poId,
  status,
  lines,
}: {
  poId: string;
  status: string;
  lines: POLine[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // Per-line receive quantities (default = remaining).
  const [recv, setRecv] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      lines.map((l) => [l.id, String(Math.max(0, Number(l.quantity) - Number(l.receivedQty)))]),
    ),
  );

  const canReceive = status === 'submitted' || status === 'partial';

  function act(path: string, body?: unknown) {
    setError(null);
    start(async () => {
      const res = await apiClientFetch(`/api/v1/purchase-orders/${poId}/${path}`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      });
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Action failed.');
        return;
      }
      router.refresh();
    });
  }

  function receive() {
    const payload = lines
      .map((l) => ({ lineId: l.id, receiveQty: Number(recv[l.id] ?? '0') }))
      .filter((r) => r.receiveQty > 0);
    if (payload.length === 0) {
      setError('Enter a quantity to receive.');
      return;
    }
    act('receive', { lines: payload });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        {status === 'draft' && (
          <button type="button" onClick={() => act('submit')} disabled={pending} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" data-testid="po-submit">
            Submit
          </button>
        )}
        {status !== 'received' && status !== 'canceled' && (
          <button type="button" onClick={() => act('cancel')} disabled={pending} className="rounded-md border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50" data-testid="po-cancel">
            Cancel
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-3 py-2 font-medium">SKU</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 font-medium text-right">Ordered</th>
              <th className="px-3 py-2 font-medium text-right">Received</th>
              <th className="px-3 py-2 font-medium text-right">Unit cost</th>
              {canReceive && <th className="px-3 py-2 font-medium text-right">Receive</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lines.map((l) => {
              const ordered = Number(l.quantity);
              const received = Number(l.receivedQty);
              const full = received >= ordered;
              return (
                <tr key={l.id}>
                  <td className="px-3 py-2 font-mono text-slate-900">{l.sku}</td>
                  <td className="px-3 py-2 text-slate-600">{l.description ?? '—'}</td>
                  <td className="px-3 py-2 text-right text-slate-900">{ordered}</td>
                  <td className={`px-3 py-2 text-right ${full ? 'text-emerald-700' : 'text-amber-700'}`}>{received}</td>
                  <td className="px-3 py-2 text-right text-slate-700">{money(l.unitCostCents)}</td>
                  {canReceive && (
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        max={ordered - received}
                        value={recv[l.id] ?? '0'}
                        onChange={(e) => setRecv((p) => ({ ...p, [l.id]: e.target.value }))}
                        disabled={full}
                        className="w-20 rounded border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-50"
                        data-testid={`po-recv-${l.id}`}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {canReceive && (
        <button type="button" onClick={receive} disabled={pending} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50" data-testid="po-receive">
          {pending ? 'Receiving…' : 'Receive into stock'}
        </button>
      )}
      {error && <p className="text-sm text-rose-600">{error}</p>}
    </div>
  );
}
