'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { apiClientFetch } from '../../../lib/api.js';

export interface PricebookRow {
  serviceItemId: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  basePrice: string;
  floorPrice: string | null;
  ceilingPrice: string | null;
  overrideId: string | null;
  overridePrice: string | null;
  effectivePrice: string;
  overridden: boolean;
}

export function PricebookTable({ rows }: { rows: PricebookRow[] }) {
  const grouped = useMemo(() => {
    const m = new Map<string, PricebookRow[]>();
    for (const r of rows) {
      if (!m.has(r.category)) m.set(r.category, []);
      m.get(r.category)!.push(r);
    }
    return m;
  }, [rows]);

  return (
    <div
      data-testid="pricebook-table"
      className="bg-white rounded-lg border border-slate-200 overflow-hidden"
    >
      {[...grouped.entries()].map(([cat, list]) => (
        <section key={cat}>
          <header className="bg-slate-50 px-4 py-2 border-b border-slate-200 text-xs font-medium uppercase tracking-wide text-slate-600">
            {cat}
          </header>
          <table className="min-w-full text-sm divide-y divide-slate-100">
            <thead className="sr-only">
              <tr>
                <th>Item</th>
                <th>Base</th>
                <th>Effective</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((r) => (
                <PriceRow key={r.serviceItemId} row={r} />
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

function PriceRow({ row }: { row: PricebookRow }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(
    row.overridePrice ?? row.basePrice ?? '',
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const base = Number(row.basePrice);
  const effective = Number(row.effectivePrice);
  const floor = row.floorPrice == null ? null : Number(row.floorPrice);
  const ceiling = row.ceilingPrice == null ? null : Number(row.ceilingPrice);

  function save() {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      setError('Price must be a non-negative number.');
      return;
    }
    if (floor !== null && n < floor) {
      setError(`Below floor $${floor.toFixed(2)}.`);
      return;
    }
    if (ceiling !== null && n > ceiling) {
      setError(`Above ceiling $${ceiling.toFixed(2)}.`);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch('/api/v1/pricebook/overrides', {
        method: 'POST',
        body: JSON.stringify({ serviceItemId: row.serviceItemId, overridePrice: n }),
      });
      if (res.status !== 200 && res.status !== 201) {
        setError(res.body.error?.message ?? 'Save failed.');
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function revert() {
    if (!row.overrideId) return;
    startTransition(async () => {
      const res = await apiClientFetch(
        `/api/v1/pricebook/overrides/${row.overrideId}`,
        { method: 'DELETE' },
      );
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Revert failed.');
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  return (
    <tr>
      <td className="px-4 py-2">
        <div className="font-medium text-slate-900">{row.name}</div>
        <div className="text-xs text-slate-500 font-mono">
          {row.sku} · per {row.unit}
        </div>
      </td>
      <td className="px-4 py-2 text-right text-xs text-slate-500 tabular-nums">
        base ${base.toFixed(2)}
      </td>
      <td className="px-4 py-2 text-right tabular-nums">
        {editing ? (
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-1">
              <span className="text-slate-500">$</span>
              <input
                type="number"
                step="0.01"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="w-24 rounded border border-slate-300 px-2 py-1 text-sm tabular-nums text-right"
              />
            </div>
            {(floor !== null || ceiling !== null) && (
              <div className="text-[10px] text-slate-500">
                {floor !== null && `floor $${floor.toFixed(2)}`}
                {floor !== null && ceiling !== null && ' · '}
                {ceiling !== null && `ceiling $${ceiling.toFixed(2)}`}
              </div>
            )}
            {error && (
              <div className="text-[11px] text-red-700" role="alert">
                {error}
              </div>
            )}
          </div>
        ) : (
          <>
            <span
              className={row.overridden ? 'font-medium text-slate-900' : 'text-slate-800'}
            >
              ${effective.toFixed(2)}
            </span>
            {row.overridden && (
              <div className="text-[10px] text-blue-700">overridden</div>
            )}
          </>
        )}
      </td>
      <td className="px-4 py-2 text-right">
        {editing ? (
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              className="text-xs text-slate-500 hover:underline"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs text-blue-700 hover:underline"
              data-testid={`override-${row.sku}`}
            >
              Override
            </button>
            {row.overridden && (
              <button
                type="button"
                onClick={revert}
                disabled={pending}
                className="text-xs text-red-700 hover:underline disabled:opacity-50"
              >
                Revert
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}
