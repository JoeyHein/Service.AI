'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';

export function NewItemForm() {
  const router = useRouter();
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [unit, setUnit] = useState('each');
  const [unitCost, setUnitCost] = useState('');
  const [qtyOnHand, setQtyOnHand] = useState('');
  const [reorderPoint, setReorderPoint] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const body: Record<string, unknown> = { sku, name };
      if (category) body.category = category;
      if (unit) body.unit = unit;
      if (unitCost) body.unitCostCents = Math.round(Number(unitCost) * 100);
      if (qtyOnHand) body.qtyOnHand = Number(qtyOnHand);
      if (reorderPoint) body.reorderPoint = Number(reorderPoint);
      const res = await apiClientFetch<{ id: string }>('/api/v1/inventory/items', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (res.status !== 201 || !res.body.ok || !res.body.data) {
        setError(res.body.error?.message ?? 'Could not create item.');
        return;
      }
      router.push(`/inventory/${res.body.data.id}`);
      router.refresh();
    });
  }

  const field = 'mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm';
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">SKU</span>
          <input required value={sku} onChange={(e) => setSku(e.target.value)} className={field} />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} className={field} />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Category</span>
          <input value={category} onChange={(e) => setCategory(e.target.value)} className={field} placeholder="spring, hardware…" />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Unit</span>
          <input value={unit} onChange={(e) => setUnit(e.target.value)} className={field} />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Unit cost ($)</span>
          <input type="number" step="0.01" min="0" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} className={field} />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Opening on-hand</span>
          <input type="number" step="0.001" min="0" value={qtyOnHand} onChange={(e) => setQtyOnHand(e.target.value)} className={field} />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Reorder point</span>
          <input type="number" step="0.001" min="0" value={reorderPoint} onChange={(e) => setReorderPoint(e.target.value)} className={field} />
        </label>
      </div>
      {error && (
        <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create item'}
      </button>
    </form>
  );
}
