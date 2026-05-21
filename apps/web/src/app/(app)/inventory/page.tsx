import Link from 'next/link';
import { apiServerFetch } from '../../../lib/api.js';
import { InventoryList, type InventoryItem } from './InventoryList';

export default async function InventoryPage() {
  const [listRes, excRes] = await Promise.all([
    apiServerFetch<{ rows: InventoryItem[]; total: number }>(
      '/api/v1/inventory/items?limit=50',
    ),
    apiServerFetch<{ rows: unknown[]; total: number }>(
      '/api/v1/inventory/exceptions?status=pending&limit=1',
    ),
  ]);
  const data = listRes.body.ok ? listRes.body.data : undefined;
  const pendingExceptions = excRes.body.ok ? (excRes.body.data?.total ?? 0) : 0;

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Inventory</h1>
          <p className="mt-1 text-sm text-slate-500">
            Branch parts stock — on-hand, reorder points, and movement history.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {pendingExceptions > 0 && (
            <Link
              href="/inventory/exceptions"
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100"
            >
              Reconcile ({pendingExceptions})
            </Link>
          )}
          <Link
            href="/inventory/new"
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            New item
          </Link>
        </div>
      </div>
      <InventoryList initialRows={data?.rows ?? []} initialTotal={data?.total ?? 0} />
    </section>
  );
}
