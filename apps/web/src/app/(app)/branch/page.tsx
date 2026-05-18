import Link from 'next/link';
import { apiServerFetch } from '../../../lib/api.js';

interface DashboardResponse {
  branch: {
    id: string;
    name: string;
    slug: string;
    status: string;
  };
  period: string;
  tiles: {
    revenueMtdCents: number;
    openArCents: number;
    jobsInFlight: number;
    projectedCommissionCents: number;
  };
  commission: {
    period: string;
    baseSalaryCents: number;
    commissionCents: number;
    totalCents: number;
  };
  pipeline: Array<{
    quoteId: string;
    customerName: string;
    totalCents: number;
    committedAt: string;
  }>;
  recentJobs: Array<{
    jobId: string;
    customerName: string;
    status: string;
    scheduledStart: string | null;
    revenueCents: number;
  }>;
}

function formatUsd(cents: number): string {
  const dollars = cents / 100;
  return dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Tile used for the four headline metrics. Kept inline rather than
 * pulled from `@service-ai/ui` to match the existing /dashboard page's
 * "Tailwind-only, no abstraction" style.
 */
function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
      {hint ? <div className="mt-1 text-xs text-slate-500">{hint}</div> : null}
    </div>
  );
}

export default async function BranchDashboardPage() {
  const res = await apiServerFetch<DashboardResponse>('/api/v1/branch/dashboard', {
    cache: 'no-store',
  });

  if (!res.body.ok || !res.body.data) {
    const err = res.body.ok ? null : res.body.error;
    return (
      <div className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-2xl font-semibold">Branch dashboard</h1>
        <p className="mt-4 text-sm text-rose-600">
          Unable to load dashboard ({err?.code ?? 'UNKNOWN'}):{' '}
          {err?.message ?? 'Please try again.'}
        </p>
      </div>
    );
  }

  const d: DashboardResponse = res.body.data;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            {d.branch.name}
          </h1>
          <div className="mt-1 text-sm text-slate-500">
            Branch dashboard · {d.period}
            <span
              className={`ml-3 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                d.branch.status === 'active'
                  ? 'bg-emerald-50 text-emerald-700'
                  : d.branch.status === 'paused'
                    ? 'bg-amber-50 text-amber-700'
                    : 'bg-slate-100 text-slate-600'
              }`}
            >
              {d.branch.status}
            </span>
          </div>
        </div>
        <div className="text-sm text-slate-500">
          <Link href="/dispatch" className="text-blue-600 hover:underline">
            Open dispatch →
          </Link>
        </div>
      </header>

      <section
        aria-labelledby="branch-tiles"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <h2 id="branch-tiles" className="sr-only">
          Key metrics
        </h2>
        <Tile label="Revenue MTD" value={formatUsd(d.tiles.revenueMtdCents)} />
        <Tile label="Open AR" value={formatUsd(d.tiles.openArCents)} />
        <Tile
          label="Jobs in flight"
          value={String(d.tiles.jobsInFlight)}
          hint="scheduled · en route · in progress"
        />
        <Tile
          label="Projected commission"
          value={formatUsd(d.tiles.projectedCommissionCents)}
          hint={`base ${formatUsd(d.commission.baseSalaryCents)} + comm ${formatUsd(
            d.commission.commissionCents,
          )}`}
        />
      </section>

      <section className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm lg:col-span-1">
          <h2 className="text-sm font-medium text-slate-700">Pipeline</h2>
          <p className="mt-1 text-xs text-slate-500">
            Committed supplier quotes awaiting invoice
          </p>
          {d.pipeline.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              No committed quotes pending invoice.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {d.pipeline.map((q) => (
                <li
                  key={q.quoteId}
                  className="flex items-baseline justify-between text-sm"
                >
                  <span className="text-slate-700">{q.customerName}</span>
                  <span className="font-medium text-slate-900">
                    {formatUsd(q.totalCents)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm lg:col-span-2">
          <h2 className="text-sm font-medium text-slate-700">Recent jobs</h2>
          {d.recentJobs.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">No recent jobs.</p>
          ) : (
            <table className="mt-3 w-full table-auto text-sm">
              <thead className="text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2 pr-2">Customer</th>
                  <th className="py-2 pr-2">Scheduled</th>
                  <th className="py-2 pr-2">Status</th>
                  <th className="py-2 pr-2 text-right">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {d.recentJobs.map((j) => (
                  <tr key={j.jobId}>
                    <td className="py-2 pr-2 text-slate-800">
                      <Link
                        href={`/jobs/${j.jobId}`}
                        className="text-blue-600 hover:underline"
                      >
                        {j.customerName}
                      </Link>
                    </td>
                    <td className="py-2 pr-2 text-slate-600">
                      {formatDateTime(j.scheduledStart)}
                    </td>
                    <td className="py-2 pr-2 text-slate-600">{j.status}</td>
                    <td className="py-2 pr-2 text-right font-medium text-slate-900">
                      {formatUsd(j.revenueCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
