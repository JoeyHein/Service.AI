import Link from 'next/link';
import { apiServerFetch } from '../../../../lib/api.js';
import { NewPurchaseOrderForm, type SupplierOption } from './NewPurchaseOrderForm';

export default async function NewPurchaseOrderPage() {
  const res = await apiServerFetch<{ rows: SupplierOption[] }>('/api/v1/suppliers');
  const suppliers = res.body.ok ? (res.body.data?.rows ?? []) : [];

  return (
    <section className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">New purchase order</h1>
        <Link href="/purchase-orders" className="text-sm text-slate-600 hover:underline">
          ← Purchase orders
        </Link>
      </div>
      <NewPurchaseOrderForm suppliers={suppliers} />
    </section>
  );
}
