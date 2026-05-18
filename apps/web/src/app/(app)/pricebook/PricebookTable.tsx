'use client';

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
  effectivePrice: string;
}

/**
 * Branch pricebook table. The corporate-hub redesign (CHR-08/09) removed
 * the inline override flow — branches no longer set their own prices.
 * Managers can suggest a change via the "Suggest" button, which lands
 * in /corporate/pricebook-suggestions for corporate review.
 *
 * Non-manager branch roles see the table read-only.
 */
export function PricebookTable({
  rows,
  canSuggest,
}: {
  rows: PricebookRow[];
  canSuggest: boolean;
}) {
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
                <PriceRow key={r.serviceItemId} row={r} canSuggest={canSuggest} />
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

function PriceRow({
  row,
  canSuggest,
}: {
  row: PricebookRow;
  canSuggest: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const base = Number(row.basePrice);
  const effective = Number(row.effectivePrice);
  const floor = row.floorPrice == null ? null : Number(row.floorPrice);
  const ceiling = row.ceilingPrice == null ? null : Number(row.ceilingPrice);

  function submit() {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      setError('Suggested price must be a non-negative number.');
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch('/api/v1/pricebook/suggestions', {
        method: 'POST',
        body: JSON.stringify({
          serviceItemId: row.serviceItemId,
          suggestedPriceCents: Math.round(n * 100),
          reason: reason.trim() || undefined,
        }),
      });
      if (res.status !== 200 && res.status !== 201) {
        setError(res.body.error?.message ?? 'Submit failed.');
        return;
      }
      setSubmitted(true);
      setOpen(false);
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
        {(floor !== null || ceiling !== null) && (
          <div className="text-[10px] text-slate-500">
            {floor !== null && `floor $${floor.toFixed(2)}`}
            {floor !== null && ceiling !== null && ' · '}
            {ceiling !== null && `ceiling $${ceiling.toFixed(2)}`}
          </div>
        )}
      </td>
      <td className="px-4 py-2 text-right tabular-nums font-medium text-slate-900">
        ${effective.toFixed(2)}
      </td>
      <td className="px-4 py-2 text-right">
        {!canSuggest ? null : submitted ? (
          <span className="text-xs text-emerald-700">Suggested ✓</span>
        ) : open ? (
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-1">
              <span className="text-slate-500">$</span>
              <input
                type="number"
                step="0.01"
                placeholder="new price"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="w-24 rounded border border-slate-300 px-2 py-1 text-sm tabular-nums text-right"
              />
            </div>
            <input
              type="text"
              placeholder="reason (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-48 rounded border border-slate-300 px-2 py-1 text-xs"
            />
            {error && (
              <div className="text-[11px] text-red-700" role="alert">
                {error}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={submit}
                disabled={pending}
                className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-60"
              >
                {pending ? 'Sending…' : 'Submit'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setError(null);
                  setValue('');
                  setReason('');
                }}
                className="text-xs text-slate-500 hover:underline"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-xs text-blue-700 hover:underline"
          >
            Suggest
          </button>
        )}
      </td>
    </tr>
  );
}
