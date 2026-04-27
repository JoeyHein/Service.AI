import Link from 'next/link';
import { apiServerFetch } from '../../../lib/api.js';
import { getSession } from '../../../lib/session.js';
import { PricebookTable, type PricebookRow } from './PricebookTable';

interface PricebookPayload {
  franchiseeId: string;
  franchisorId: string;
  rows: PricebookRow[];
}

export default async function PricebookPage() {
  const session = await getSession();
  // Pricebook is per-franchisee. Admins not currently impersonating
  // need to pick one — render a friendly CTA instead of a 400.
  if (
    session &&
    !session.impersonating &&
    (session.scope?.type === 'platform' || session.scope?.type === 'franchisor')
  ) {
    return (
      <section>
        <h1 className="text-2xl font-semibold text-slate-900">Pricebook</h1>
        <p className="mt-2 text-sm text-slate-600">
          The pricebook is scoped to a single franchisee. Pick one from the{' '}
          <Link href="/franchisor" className="text-blue-700 hover:underline">
            Network
          </Link>{' '}
          page and use &ldquo;View as&rdquo; to drop into their context, or
          edit the franchisor-level template at{' '}
          <Link
            href="/franchisor/catalog"
            className="text-blue-700 hover:underline"
          >
            Catalog
          </Link>
          .
        </p>
      </section>
    );
  }

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
