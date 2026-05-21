import { notFound } from 'next/navigation';
import Link from 'next/link';
import { apiServerFetch } from '../../../../lib/api.js';
import { PurchaseOrderActions, type POLine } from './PurchaseOrderActions';

interface PO {
  id: string;
  poNumber: string | null;
  status: string;
  subtotalCents: number;
  notes: string | null;
  expectedDate: string | null;
  submittedAt: string | null;
  receivedAt: string | null;
}

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'CAD' });
}

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700',
  submitted: 'bg-blue-100 text-blue-800',
  partial: 'bg-amber-100 text-amber-800',
  received: 'bg-emerald-100 text-emerald-800',
  canceled: 'bg-rose-100 text-rose-700',
};

export default async function PurchaseOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const res = await apiServerFetch<{ po: PO; lines: POLine[] }>(
    `/api/v1/purchase-orders/${encodeURIComponent(id)}`,
  );
  if (res.status !== 200 || !res.body.ok || !res.body.data) {
    notFound();
  }
  const { po, lines } = res.body.data;

  return (
    <section className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            {po.poNumber ?? 'Purchase order'}{' '}
            <span className={`align-middle rounded px-2 py-0.5 text-sm font-medium ${STATUS_BADGE[po.status] ?? 'bg-slate-100'}`}>
              {po.status}
            </span>
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Total {money(po.subtotalCents)}
            {po.expectedDate ? ` · expected ${new Date(po.expectedDate).toLocaleDateString()}` : ''}
            {po.submittedAt ? ` · submitted ${new Date(po.submittedAt).toLocaleDateString()}` : ''}
            {po.receivedAt ? ` · received ${new Date(po.receivedAt).toLocaleDateString()}` : ''}
          </p>
          {po.notes && <p className="mt-1 text-sm text-slate-500">{po.notes}</p>}
        </div>
        <Link href="/purchase-orders" className="text-sm text-slate-600 hover:underline">
          ← Purchase orders
        </Link>
      </div>

      <PurchaseOrderActions poId={po.id} status={po.status} lines={lines} />
    </section>
  );
}
