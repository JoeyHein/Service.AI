'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../lib/api.js';

export interface PurchaseOrder {
  id: string;
  poNumber: string | null;
  status: string;
  subtotalCents: number;
  expectedDate: string | null;
  createdAt: string;
}

type StatusFilter = 'all' | 'draft' | 'submitted' | 'partial' | 'received' | 'canceled';

const FILTERS: StatusFilter[] = ['all', 'draft', 'submitted', 'partial', 'received', 'canceled'];

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700',
  submitted: 'bg-blue-100 text-blue-800',
  partial: 'bg-amber-100 text-amber-800',
  received: 'bg-emerald-100 text-emerald-800',
  canceled: 'bg-rose-100 text-rose-700',
};

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'CAD' });
}

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function PurchaseOrderList({
  initialRows,
  initialTotal,
}: {
  initialRows: PurchaseOrder[];
  initialTotal: number;
}) {
  const [rows, setRows] = useState<PurchaseOrder[]>(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [loading, startLoading] = useTransition();

  function load(next: StatusFilter) {
    setStatus(next);
    startLoading(async () => {
      const params = new URLSearchParams({ limit: '50' });
      if (next !== 'all') params.set('status', next);
      const res = await apiClientFetch<{ rows: PurchaseOrder[]; total: number }>(
        `/api/v1/purchase-orders?${params.toString()}`,
      );
      if (res.status === 200 && res.body.ok && res.body.data) {
        setRows(res.body.data.rows);
        setTotal(res.body.data.total);
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => load(f)}
            className={`rounded-md px-3 py-1 text-sm capitalize ${
              status === f ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
            data-testid={`po-filter-${f}`}
          >
            {f}
          </button>
        ))}
        <span className="ml-auto text-xs text-slate-500">
          {loading ? 'Loading…' : `${total} PO${total === 1 ? '' : 's'}`}
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">No purchase orders.</p>
        ) : (
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-3 py-2 font-medium">PO #</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium text-right">Total</th>
                <th className="px-3 py-2 font-medium">Expected</th>
                <th className="px-3 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((po) => (
                <tr key={po.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <Link href={`/purchase-orders/${po.id}`} className="font-medium text-blue-700 hover:underline">
                      {po.poNumber ?? po.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[po.status] ?? 'bg-slate-100'}`}>
                      {po.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-slate-900">{money(po.subtotalCents)}</td>
                  <td className="px-3 py-2 text-slate-500">{shortDate(po.expectedDate)}</td>
                  <td className="px-3 py-2 text-slate-500">{shortDate(po.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
