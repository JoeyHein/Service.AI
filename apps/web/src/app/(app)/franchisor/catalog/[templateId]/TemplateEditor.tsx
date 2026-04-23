'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../../lib/api.js';

export interface Template {
  id: string;
  name: string;
  slug: string;
  status: 'draft' | 'published' | 'archived';
}

export interface Item {
  id: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  basePrice: string;
  floorPrice: string | null;
  ceilingPrice: string | null;
}

export function TemplateEditor({
  template,
  initialItems,
}: {
  template: Template;
  initialItems: Item[];
}) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>(initialItems);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const editable = template.status === 'draft';

  // Inline add form
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('Installs');
  const [unit, setUnit] = useState('each');
  const [basePrice, setBasePrice] = useState('');
  const [floorPrice, setFloorPrice] = useState('');
  const [ceilingPrice, setCeilingPrice] = useState('');

  function resetForm() {
    setSku('');
    setName('');
    setBasePrice('');
    setFloorPrice('');
    setCeilingPrice('');
  }

  function addItem() {
    setError(null);
    startTransition(async () => {
      const body: Record<string, unknown> = {
        sku,
        name,
        category,
        unit,
        basePrice: Number(basePrice),
      };
      if (floorPrice) body.floorPrice = Number(floorPrice);
      if (ceilingPrice) body.ceilingPrice = Number(ceilingPrice);
      const res = await apiClientFetch<Item>(
        `/api/v1/catalog/templates/${template.id}/items`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      if (res.status !== 201) {
        setError(res.body.error?.message ?? 'Failed.');
        return;
      }
      setItems((prev) => [...prev, res.body.data!]);
      resetForm();
      router.refresh();
    });
  }

  function deleteItem(id: string) {
    startTransition(async () => {
      const res = await apiClientFetch(
        `/api/v1/catalog/templates/${template.id}/items/${id}`,
        { method: 'DELETE' },
      );
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Delete failed.');
        return;
      }
      setItems((prev) => prev.filter((i) => i.id !== id));
      router.refresh();
    });
  }

  function publish() {
    if (!confirm('Publish this template? The currently-published one will be archived.'))
      return;
    startTransition(async () => {
      const res = await apiClientFetch(
        `/api/v1/catalog/templates/${template.id}/publish`,
        { method: 'POST' },
      );
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Publish failed.');
        return;
      }
      router.refresh();
    });
  }

  function archive() {
    if (!confirm('Archive this template?')) return;
    startTransition(async () => {
      const res = await apiClientFetch(
        `/api/v1/catalog/templates/${template.id}/archive`,
        { method: 'POST' },
      );
      if (res.status !== 200) {
        setError(res.body.error?.message ?? 'Archive failed.');
        return;
      }
      router.refresh();
    });
  }

  return (
    <>
      <div className="mt-6 flex flex-wrap gap-2">
        {template.status === 'draft' && (
          <button
            type="button"
            onClick={publish}
            disabled={pending}
            className="rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            data-testid="publish-btn"
          >
            {pending ? '…' : 'Publish'}
          </button>
        )}
        {template.status !== 'archived' && (
          <button
            type="button"
            onClick={archive}
            disabled={pending}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            data-testid="archive-btn"
          >
            {pending ? '…' : 'Archive'}
          </button>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      <div
        data-testid="items-table"
        className="mt-6 bg-white rounded-lg border border-slate-200 overflow-hidden"
      >
        <table className="min-w-full text-sm divide-y divide-slate-200">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-3 py-2 font-medium">SKU</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 font-medium text-right">Base</th>
              <th className="px-3 py-2 font-medium text-right">Floor</th>
              <th className="px-3 py-2 font-medium text-right">Ceiling</th>
              {editable && <th className="px-3 py-2 font-medium" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((i) => (
              <tr key={i.id}>
                <td className="px-3 py-2 font-mono text-xs">{i.sku}</td>
                <td className="px-3 py-2">{i.name}</td>
                <td className="px-3 py-2 text-slate-600">{i.category}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  ${Number(i.basePrice).toFixed(2)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                  {i.floorPrice ? `$${Number(i.floorPrice).toFixed(2)}` : '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                  {i.ceilingPrice ? `$${Number(i.ceilingPrice).toFixed(2)}` : '—'}
                </td>
                {editable && (
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => deleteItem(i.id)}
                      className="text-xs text-red-700 hover:underline"
                    >
                      delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={editable ? 7 : 6}
                  className="px-3 py-6 text-center text-sm text-slate-500"
                >
                  No items yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editable && (
        <div className="mt-6 bg-white rounded-lg border border-slate-200 p-4">
          <h2 className="text-sm font-medium text-slate-700">Add item</h2>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
            <input
              placeholder="SKU"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm font-mono"
            />
            <input
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm md:col-span-2"
            />
            <input
              placeholder="Category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm"
            />
            <input
              placeholder="Unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm"
            />
            <div />
            <input
              type="number"
              step="0.01"
              placeholder="Base price"
              value={basePrice}
              onChange={(e) => setBasePrice(e.target.value)}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm tabular-nums"
            />
            <input
              type="number"
              step="0.01"
              placeholder="Floor (optional)"
              value={floorPrice}
              onChange={(e) => setFloorPrice(e.target.value)}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm tabular-nums"
            />
            <input
              type="number"
              step="0.01"
              placeholder="Ceiling (optional)"
              value={ceilingPrice}
              onChange={(e) => setCeilingPrice(e.target.value)}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm tabular-nums"
            />
          </div>
          <div className="mt-3">
            <button
              type="button"
              onClick={addItem}
              disabled={pending || !sku || !name || !basePrice}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {pending ? 'Adding…' : 'Add item'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
