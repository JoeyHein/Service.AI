import Link from 'next/link';
import { apiServerFetch } from '../../../../lib/api.js';
import { ExceptionsInbox, type Exception } from './ExceptionsInbox';

export default async function InventoryExceptionsPage() {
  const res = await apiServerFetch<{ rows: Exception[]; total: number }>(
    '/api/v1/inventory/exceptions?status=pending&limit=100',
  );
  const data = res.body.ok ? res.body.data : undefined;

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Inventory reconciliation</h1>
          <p className="mt-1 text-sm text-slate-500">
            Parts consumed on completed jobs whose SKU isn&apos;t stocked yet. Create
            or link an item to record the consumption, or ignore it.
          </p>
        </div>
        <Link href="/inventory" className="text-sm text-slate-600 hover:underline">
          ← Inventory
        </Link>
      </div>
      <ExceptionsInbox initialRows={data?.rows ?? []} />
    </section>
  );
}
