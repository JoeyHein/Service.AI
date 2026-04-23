import { apiServerFetch } from '../../../lib/api.js';
import { PricebookTable, type PricebookRow } from './PricebookTable';

interface PricebookPayload {
  franchiseeId: string;
  franchisorId: string;
  rows: PricebookRow[];
}

export default async function PricebookPage() {
  const res = await apiServerFetch<PricebookPayload>('/api/v1/pricebook');
  if (res.status !== 200 || !res.body.ok || !res.body.data) {
    return (
      <section>
        <h1 className="text-2xl font-semibold text-slate-900">Pricebook</h1>
        <p className="mt-2 text-sm text-slate-600">
          {res.body.error?.message ?? 'No published catalog available.'}
        </p>
      </section>
    );
  }
  const { rows } = res.body.data;
  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">Pricebook</h1>
      <p className="mt-1 text-sm text-slate-500">
        Inherited from your franchisor&apos;s published catalog.
        {rows.length === 0 ? ' No items yet.' : ` ${rows.length} items.`}
      </p>
      <div className="mt-6">
        <PricebookTable rows={rows} />
      </div>
    </section>
  );
}
