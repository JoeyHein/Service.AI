import Link from 'next/link';
import { apiServerFetch } from '../../../../lib/api.js';
import { BranchesTable } from './BranchesTable';

export interface BranchRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  currentManagerName: string | null;
  revenueMtdCents: number;
  commissionPaidMtdCents: number;
}

/**
 * Branches directory. Server fetch + a small client wrapper that handles
 * sort + status filter. View-as link drops the operator into the per-
 * branch detail page.
 */
export default async function BranchesPage() {
  const res = await apiServerFetch<BranchRow[]>('/api/v1/corporate/branches');
  const rows = res.body.ok && res.body.data ? res.body.data : [];

  return (
    <section>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Branches</h1>
          <p className="mt-1 text-sm text-slate-500">
            {rows.length === 0
              ? 'No branches yet — create the first one.'
              : `${rows.length} branch${rows.length === 1 ? '' : 'es'} in the network.`}
          </p>
        </div>
        <Link
          href="/corporate/branches/new"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          New branch
        </Link>
      </div>

      <div className="mt-6">
        <BranchesTable rows={rows} />
      </div>
    </section>
  );
}
