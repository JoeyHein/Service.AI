import Link from 'next/link';
import { apiServerFetch } from '../../../lib/api.js';
import { PurchaseOrderList, type PurchaseOrder } from './PurchaseOrderList';

export default async function PurchaseOrdersPage() {
  const res = await apiServerFetch<{ rows: PurchaseOrder[]; total: number }>(
    '/api/v1/purchase-orders?limit=50',
  );
  const data = res.body.ok ? res.body.data : undefined;

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Purchase orders</h1>
          <p className="mt-1 text-sm text-slate-500">
            Replenish branch stock. Receiving a PO adds to inventory on-hand.
          </p>
        </div>
        <Link
          href="/purchase-orders/new"
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          New PO
        </Link>
      </div>
      <PurchaseOrderList initialRows={data?.rows ?? []} initialTotal={data?.total ?? 0} />
    </section>
  );
}
