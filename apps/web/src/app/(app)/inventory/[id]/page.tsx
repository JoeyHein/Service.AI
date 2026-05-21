import { notFound } from 'next/navigation';
import Link from 'next/link';
import { apiServerFetch } from '../../../../lib/api.js';
import { AdjustForm } from './AdjustForm';
import type { InventoryItem } from '../InventoryList';

interface Movement {
  id: string;
  deltaQty: string;
  reason: string;
  refType: string | null;
  refId: string | null;
  note: string | null;
  createdAt: string;
}

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'CAD' });
}

export default async function InventoryItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const res = await apiServerFetch<{ item: InventoryItem; movements: Movement[] }>(
    `/api/v1/inventory/items/${encodeURIComponent(id)}`,
  );
  if (res.status !== 200 || !res.body.ok || !res.body.data) {
    notFound();
  }
  const { item, movements } = res.body.data;
  const onHand = Number(item.qtyOnHand);
  const reserved = Number(item.qtyReserved);
  const available = onHand - reserved;
  const low = item.active && available <= Number(item.reorderPoint);

  return (
    <section className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            {item.name}{' '}
            {low && (
              <span className="align-middle rounded bg-rose-100 px-2 py-0.5 text-sm font-medium text-rose-700">
                low stock
              </span>
            )}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            <span className="font-mono">{item.sku}</span>
            {item.category ? ` · ${item.category}` : ''} · {item.unit}
            {item.bin ? ` · bin ${item.bin}` : ''}
          </p>
        </div>
        <Link href="/inventory" className="text-sm text-slate-600 hover:underline">
          ← Inventory
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          { label: 'On hand', value: `${onHand} ${item.unit}` },
          { label: 'Reserved', value: `${reserved}` },
          { label: 'Available', value: `${available}` },
          { label: 'Reorder point', value: `${Number(item.reorderPoint)}` },
        ].map((c) => (
          <div key={c.label} className="rounded-lg border border-slate-200 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">{c.label}</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{c.value}</p>
          </div>
        ))}
      </div>

      <AdjustForm itemId={item.id} unit={item.unit} />

      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-medium text-slate-900">
          Movement history
        </div>
        {movements.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-slate-500">No movements yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {movements.map((m) => {
              const delta = Number(m.deltaQty);
              return (
                <li key={m.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <div>
                    <span className={`font-medium ${delta < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                      {delta > 0 ? `+${delta}` : delta}
                    </span>
                    <span className="ml-2 text-slate-600">{m.reason}</span>
                    {m.refType === 'job' && m.refId && (
                      <Link href={`/jobs/${m.refId}`} className="ml-2 text-xs text-blue-700 hover:underline">
                        job
                      </Link>
                    )}
                    {m.note && <span className="ml-2 text-xs text-slate-400">{m.note}</span>}
                  </div>
                  <span className="text-xs text-slate-400">
                    {new Date(m.createdAt).toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="text-xs text-slate-400">Unit cost {money(item.unitCostCents)}</p>
    </section>
  );
}
