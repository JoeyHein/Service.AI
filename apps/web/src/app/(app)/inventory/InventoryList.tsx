'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../lib/api.js';

export interface InventoryItem {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  unit: string;
  unitCostCents: number;
  qtyOnHand: string;
  qtyReserved: string;
  reorderPoint: string;
  bin: string | null;
  active: boolean;
}

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'CAD' });
}

function available(item: InventoryItem): number {
  return Number(item.qtyOnHand) - Number(item.qtyReserved);
}

function isLow(item: InventoryItem): boolean {
  return item.active && available(item) <= Number(item.reorderPoint);
}

export function InventoryList({
  initialRows,
  initialTotal,
}: {
  initialRows: InventoryItem[];
  initialTotal: number;
}) {
  const [rows, setRows] = useState<InventoryItem[]>(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [loading, startLoading] = useTransition();

  function reload(nextSearch: string, nextLow: boolean) {
    setSearch(nextSearch);
    setLowOnly(nextLow);
    startLoading(async () => {
      const params = new URLSearchParams({ limit: '50' });
      if (nextSearch.trim()) params.set('search', nextSearch.trim());
      if (nextLow) params.set('lowStock', 'true');
      const res = await apiClientFetch<{ rows: InventoryItem[]; total: number }>(
        `/api/v1/inventory/items?${params.toString()}`,
      );
      if (res.status === 200 && res.body.ok && res.body.data) {
        setRows(res.body.data.rows);
        setTotal(res.body.data.total);
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => reload(e.target.value, lowOnly)}
          placeholder="Search SKU or name…"
          className="min-w-[16rem] flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
          data-testid="inventory-search"
        />
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={lowOnly}
            onChange={(e) => reload(search, e.target.checked)}
            data-testid="low-only"
          />
          Low stock only
        </label>
        <span className="ml-auto text-xs text-slate-500">
          {loading ? 'Loading…' : `${total} item${total === 1 ? '' : 's'}`}
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">No items.</p>
        ) : (
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-3 py-2 font-medium">SKU</th>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="px-3 py-2 font-medium text-right">On hand</th>
                <th className="px-3 py-2 font-medium text-right">Available</th>
                <th className="px-3 py-2 font-medium text-right">Reorder</th>
                <th className="px-3 py-2 font-medium text-right">Unit cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <Link href={`/inventory/${item.id}`} className="font-medium text-blue-700 hover:underline">
                      {item.sku}
                    </Link>
                    {isLow(item) && (
                      <span className="ml-2 rounded bg-rose-100 px-1.5 py-0.5 text-xs font-medium text-rose-700">
                        low
                      </span>
                    )}
                    {!item.active && (
                      <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                        inactive
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-900">{item.name}</td>
                  <td className="px-3 py-2 text-slate-500">{item.category ?? '—'}</td>
                  <td className="px-3 py-2 text-right text-slate-900">
                    {Number(item.qtyOnHand)} {item.unit}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-700">{available(item)}</td>
                  <td className="px-3 py-2 text-right text-slate-500">{Number(item.reorderPoint)}</td>
                  <td className="px-3 py-2 text-right text-slate-700">{money(item.unitCostCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
