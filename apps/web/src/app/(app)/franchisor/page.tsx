import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiServerFetch } from '../../../lib/api.js';
import { getSession } from '../../../lib/session.js';
import { ImpersonateButton } from './ImpersonateButton';

interface PerFranchisee {
  franchiseeId: string;
  name: string;
  revenueCents: number;
  openArCents: number;
  jobsCount: number;
  aiCostUsd: number;
  royaltyCollectedCents: number;
}

interface NetworkMetrics {
  totals: {
    revenueCents: number;
    openArCents: number;
    aiCostUsd: number;
    royaltyCollectedCents: number;
    jobsCount: number;
    franchiseeCount: number;
  };
  perFranchisee: PerFranchisee[];
}

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

/**
 * Top-level /franchisor network dashboard. Platform + franchisor
 * admins only. Four tiles + per-franchisee table with a quick
 * "View as" button that kicks the impersonation flow.
 */
export default async function FranchisorDashboardPage() {
  const session = await getSession();
  if (
    !session ||
    (session.scope?.type !== 'platform' && session.scope?.type !== 'franchisor')
  ) {
    notFound();
  }
  const res = await apiServerFetch<NetworkMetrics>(
    '/api/v1/franchisor/network-metrics',
  );
  const m: NetworkMetrics =
    res.body.ok && res.body.data
      ? res.body.data
      : {
          totals: {
            revenueCents: 0,
            openArCents: 0,
            aiCostUsd: 0,
            royaltyCollectedCents: 0,
            jobsCount: 0,
            franchiseeCount: 0,
          },
          perFranchisee: [],
        };

  return (
    <section>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Network</h1>
          <p className="mt-1 text-sm text-slate-500">
            Trailing 30 days across every franchisee you manage.
          </p>
        </div>
        <Link
          href="/franchisor/onboard"
          data-testid="nav-onboard"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Onboard franchisee
        </Link>
      </div>

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile label="Revenue" value={money(m.totals.revenueCents)} />
        <Tile label="Open AR" value={money(m.totals.openArCents)} />
        <Tile
          label="AI spend"
          value={`$${m.totals.aiCostUsd.toFixed(2)}`}
        />
        <Tile label="Franchisees" value={String(m.totals.franchiseeCount)} />
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full text-sm divide-y divide-slate-200">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-3 py-2 font-medium">Franchisee</th>
              <th className="px-3 py-2 font-medium text-right">Revenue</th>
              <th className="px-3 py-2 font-medium text-right">Open AR</th>
              <th className="px-3 py-2 font-medium text-right">Jobs</th>
              <th className="px-3 py-2 font-medium text-right">AI</th>
              <th className="px-3 py-2 font-medium text-right">Royalty</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {m.perFranchisee.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                  No franchisees yet.
                </td>
              </tr>
            ) : (
              m.perFranchisee.map((p) => (
                <tr key={p.franchiseeId}>
                  <td className="px-3 py-2">
                    <Link
                      href={`/franchisor/franchisees/${p.franchiseeId}/billing`}
                      className="font-medium text-blue-700 hover:underline"
                    >
                      {p.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right">{money(p.revenueCents)}</td>
                  <td className="px-3 py-2 text-right">{money(p.openArCents)}</td>
                  <td className="px-3 py-2 text-right">{p.jobsCount}</td>
                  <td className="px-3 py-2 text-right">
                    ${p.aiCostUsd.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {money(p.royaltyCollectedCents)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <ImpersonateButton franchiseeId={p.franchiseeId} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
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
