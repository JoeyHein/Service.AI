import Link from 'next/link';
import { apiServerFetch } from '../../../lib/api.js';
import { getSession } from '../../../lib/session.js';
import { PricebookTable, type PricebookRow } from './PricebookTable';

interface PricebookPayload {
  branchId: string;
  rows: PricebookRow[];
}

export default async function PricebookPage() {
  const session = await getSession();
  // Pricebook is per-branch. Corporate admins need to pick a branch
  // first — render a friendly CTA pointing to the corporate hub.
  if (session && session.scope?.type === 'corporate') {
    return (
      <section>
        <h1 className="text-2xl font-semibold text-slate-900">Pricebook</h1>
        <p className="mt-2 text-sm text-slate-600">
          The pricebook is scoped to a single branch. Pick one from the{' '}
          <Link href="/corporate/branches" className="text-blue-700 hover:underline">
            Branches
          </Link>{' '}
          page to view its catalog.
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
  const canSuggest =
    session?.scope?.type === 'branch' && session.scope.role === 'manager';
  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">Pricebook</h1>
      <p className="mt-1 text-sm text-slate-500">
        Inherited from the corporate-published catalog.
        {rows.length === 0 ? ' No items yet.' : ` ${rows.length} items.`}
        {canSuggest
          ? ' Click Suggest on any row to propose a price change for corporate review.'
          : null}
      </p>
      <div className="mt-6">
        <PricebookTable rows={rows} canSuggest={canSuggest} />
      </div>
    </section>
  );
}
