'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';

type Reason = 'receipt' | 'adjustment' | 'consumption';

export function AdjustForm({ itemId, unit }: { itemId: string; unit: string }) {
  const router = useRouter();
  const [reason, setReason] = useState<Reason>('receipt');
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    const n = Number(qty);
    if (!Number.isFinite(n) || n === 0) {
      setError('Enter a non-zero quantity.');
      return;
    }
    setError(null);
    // Receipt adds; consumption/adjustment-down subtract. The signed delta is
    // computed here: receipts are positive, consumption negative, adjustment
    // can be either via a leading minus.
    const delta = reason === 'consumption' ? -Math.abs(n) : reason === 'receipt' ? Math.abs(n) : n;
    start(async () => {
      const res = await apiClientFetch(`/api/v1/inventory/items/${itemId}/adjust`, {
        method: 'POST',
        body: JSON.stringify({ deltaQty: delta, reason, note: note || undefined }),
      });
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Adjustment failed.');
        return;
      }
      setQty('');
      setNote('');
      router.refresh();
    });
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-sm font-medium text-slate-900">Receive / adjust stock</p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="text-xs text-slate-500">Action</span>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as Reason)}
            className="mt-1 block rounded-md border border-slate-300 px-2 py-2 text-sm"
            data-testid="adjust-reason"
          >
            <option value="receipt">Receive (+)</option>
            <option value="consumption">Consume (−)</option>
            <option value="adjustment">Adjust (±)</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-slate-500">Quantity ({unit})</span>
          <input
            type="number"
            step="0.001"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder={reason === 'adjustment' ? '+/- qty' : 'qty'}
            className="mt-1 block w-32 rounded-md border border-slate-300 px-2 py-2 text-sm"
            data-testid="adjust-qty"
          />
        </label>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          className="min-w-[12rem] flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          data-testid="adjust-submit"
        >
          {pending ? 'Saving…' : 'Apply'}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
    </div>
  );
}
