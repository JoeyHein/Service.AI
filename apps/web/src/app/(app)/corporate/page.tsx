import Link from 'next/link';
import { apiServerFetch } from '../../../lib/api.js';

interface BranchRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  currentManagerName: string | null;
  revenueMtdCents: number;
  commissionPaidMtdCents: number;
}

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

/**
 * Corporate hub landing page. Four high-level tiles + a quick "Branches"
 * action. Metrics are derived client-side from the single
 * /api/v1/corporate/branches list so we don't pay an extra round trip.
 */
export default async function CorporateHomePage() {
  const res = await apiServerFetch<BranchRow[]>('/api/v1/corporate/branches');
  const rows = res.body.ok && res.body.data ? res.body.data : [];

  const branchCount = rows.length;
  const revenueMtd = rows.reduce((acc, r) => acc + r.revenueMtdCents, 0);
  const commissionPaid = rows.reduce(
    (acc, r) => acc + r.commissionPaidMtdCents,
    0,
  );
  // Open AR is not yet projected per-branch in the list endpoint; render 0
  // for now and link operators to per-branch detail for the breakdown.
  const openArMtd = 0;

  return (
    <section>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Corporate</h1>
          <p className="mt-1 text-sm text-slate-500">
            Hub overview for the current month.
          </p>
        </div>
        <Link
          href="/corporate/branches/new"
          data-testid="nav-new-branch"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          New branch
        </Link>
      </div>

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile label="Branches" value={String(branchCount)} />
        <Tile label="Revenue MTD" value={money(revenueMtd)} />
        <Tile label="Open AR" value={money(openArMtd)} />
        <Tile label="Commission paid" value={money(commissionPaid)} />
      </div>

      <div className="mt-8">
        <Link
          href="/corporate/branches"
          className="text-sm font-medium text-blue-700 hover:underline"
        >
          View all branches →
        </Link>
      </div>
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs text-slate-500 uppercase tracking-wide">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-900">{value}</p>
    </div>
  );
}
