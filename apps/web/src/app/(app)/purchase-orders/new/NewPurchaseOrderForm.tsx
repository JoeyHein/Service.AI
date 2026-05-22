'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';

export interface SupplierOption {
  id: string;
  name: string;
}

interface LineDraft {
  key: string;
  sku: string;
  description: string;
  quantity: string;
  unitCost: string;
}

function blankLine(): LineDraft {
  return { key: Math.random().toString(36).slice(2), sku: '', description: '', quantity: '1', unitCost: '' };
}

export function NewPurchaseOrderForm({ suppliers }: { suppliers: SupplierOption[] }) {
  const router = useRouter();
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? '');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([blankLine()]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [genPending, startGen] = useTransition();
  const [avail, setAvail] = useState<Record<string, { status: string; available: number }>>({});
  const [availPending, startAvail] = useTransition();

  function patch(key: string, p: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...p } : l)));
  }

  function create() {
    setError(null);
    if (!supplierId) {
      setError('Pick a supplier.');
      return;
    }
    const payloadLines = lines
      .filter((l) => l.sku.trim() && Number(l.quantity) > 0)
      .map((l) => ({
        sku: l.sku.trim(),
        description: l.description || undefined,
        quantity: Number(l.quantity),
        unitCostCents: l.unitCost ? Math.round(Number(l.unitCost) * 100) : 0,
      }));
    if (payloadLines.length === 0) {
      setError('Add at least one line with a SKU and quantity.');
      return;
    }
    start(async () => {
      const res = await apiClientFetch<{ po: { id: string } }>('/api/v1/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({ supplierId, notes: notes || undefined, lines: payloadLines }),
      });
      if (res.status !== 201 || !res.body.ok || !res.body.data) {
        setError(res.body.error?.message ?? 'Could not create PO.');
        return;
      }
      router.push(`/purchase-orders/${res.body.data.po.id}`);
      router.refresh();
    });
  }

  function generateFromLowStock() {
    setError(null);
    if (!supplierId) {
      setError('Pick a supplier first.');
      return;
    }
    startGen(async () => {
      const res = await apiClientFetch<{ po: { id: string } }>(
        '/api/v1/purchase-orders/from-low-stock',
        { method: 'POST', body: JSON.stringify({ supplierId }) },
      );
      if (res.status !== 201 || !res.body.ok || !res.body.data) {
        setError(res.body.error?.message ?? 'No low-stock items to order.');
        return;
      }
      router.push(`/purchase-orders/${res.body.data.po.id}`);
      router.refresh();
    });
  }

  function checkStock() {
    setError(null);
    if (!supplierId) {
      setError('Pick a supplier first.');
      return;
    }
    const items = lines
      .filter((l) => l.sku.trim() && Number(l.quantity) > 0)
      .map((l) => ({ sku: l.sku.trim(), quantity: Number(l.quantity) }));
    if (items.length === 0) return;
    startAvail(async () => {
      const res = await apiClientFetch<{ items: { sku: string; status: string; available: number }[] }>(
        '/api/v1/inventory/check-availability',
        { method: 'POST', body: JSON.stringify({ supplierId, items }) },
      );
      if (res.status !== 200 || !res.body.ok || !res.body.data) {
        setError(res.body.error?.message ?? 'Availability check failed.');
        return;
      }
      const map: Record<string, { status: string; available: number }> = {};
      for (const it of res.body.data.items) map[it.sku] = { status: it.status, available: it.available };
      setAvail(map);
    });
  }

  const availBadge: Record<string, string> = {
    available: 'text-emerald-700',
    partial: 'text-amber-700',
    unavailable: 'text-rose-700',
  };
  const cell = 'rounded border border-slate-300 px-2 py-1.5 text-sm';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Supplier</span>
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className={`mt-1 block min-w-[16rem] ${cell}`}
            data-testid="po-supplier"
          >
            {suppliers.length === 0 && <option value="">No suppliers configured</option>}
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={generateFromLowStock}
          disabled={genPending}
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
          data-testid="po-from-low-stock"
        >
          {genPending ? 'Generating…' : 'Generate from low stock'}
        </button>
        <button
          type="button"
          onClick={checkStock}
          disabled={availPending}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          data-testid="po-check-stock"
        >
          {availPending ? 'Checking…' : 'Check supplier stock'}
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-3 py-2 font-medium">SKU</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 font-medium">Qty</th>
              <th className="px-3 py-2 font-medium">Unit cost ($)</th>
              <th className="px-3 py-2 font-medium">Supplier stock</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lines.map((l) => (
              <tr key={l.key}>
                <td className="px-3 py-2">
                  <input value={l.sku} onChange={(e) => patch(l.key, { sku: e.target.value })} className={`w-full ${cell}`} />
                </td>
                <td className="px-3 py-2">
                  <input value={l.description} onChange={(e) => patch(l.key, { description: e.target.value })} className={`w-full ${cell}`} />
                </td>
                <td className="px-3 py-2">
                  <input type="number" step="0.001" min="0" value={l.quantity} onChange={(e) => patch(l.key, { quantity: e.target.value })} className={`w-20 ${cell}`} />
                </td>
                <td className="px-3 py-2">
                  <input type="number" step="0.01" min="0" value={l.unitCost} onChange={(e) => patch(l.key, { unitCost: e.target.value })} className={`w-28 ${cell}`} />
                </td>
                <td className="px-3 py-2 text-xs">
                  {avail[l.sku.trim()] ? (
                    <span className={availBadge[avail[l.sku.trim()]!.status] ?? 'text-slate-500'}>
                      {avail[l.sku.trim()]!.status} ({avail[l.sku.trim()]!.available})
                    </span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  {lines.length > 1 && (
                    <button type="button" onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))} className="text-xs text-rose-700 hover:underline">
                      remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={() => setLines((p) => [...p, blankLine()])} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
        Add line
      </button>

      <label className="block">
        <span className="text-sm font-medium text-slate-700">Notes</span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`mt-1 w-full ${cell}`} />
      </label>

      {error && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

      <button
        type="button"
        onClick={create}
        disabled={pending}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        data-testid="po-create"
      >
        {pending ? 'Creating…' : 'Create draft PO'}
      </button>
    </div>
  );
}
