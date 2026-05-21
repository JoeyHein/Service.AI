import { notFound } from 'next/navigation';
import Link from 'next/link';
import { apiServerFetch } from '../../../../lib/api.js';
import { EditCustomerForm, type Customer } from './EditCustomerForm';
import { CustomerActivity, type TimelineRow } from './CustomerActivity';

interface CustomerMetrics {
  lifetimeRevenueCents: number;
  outstandingCents: number;
  outstandingInvoices: number;
  avgOrderValueCents: number;
  paidInvoices: number;
  jobsByStatus: Record<string, number>;
  totalJobs: number;
  openJobs: number;
  firstJobAt: string | null;
  lastJobAt: string | null;
  quotesByStatus: Record<string, number>;
  totalQuotes: number;
  openQuotes: number;
  conversionRatePct: number;
  lastContactAt: string | null;
}

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'CAD',
    maximumFractionDigits: 0,
  });
}

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function KpiCard({
  label,
  value,
  sub,
  tone = 'slate',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'slate' | 'emerald' | 'rose' | 'blue';
}) {
  const toneClass = {
    slate: 'text-slate-900',
    emerald: 'text-emerald-700',
    rose: 'text-rose-700',
    blue: 'text-blue-700',
  }[tone];
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${toneClass}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const enc = encodeURIComponent(id);
  const [custRes, metricsRes, timelineRes] = await Promise.all([
    apiServerFetch<Customer>(`/api/v1/customers/${enc}`),
    apiServerFetch<CustomerMetrics>(`/api/v1/customers/${enc}/metrics`),
    apiServerFetch<{ rows: TimelineRow[]; total: number }>(
      `/api/v1/customers/${enc}/timeline?limit=50`,
    ),
  ]);
  if (custRes.status !== 200 || !custRes.body.ok || !custRes.body.data) {
    notFound();
  }
  const customer = custRes.body.data;
  const m = metricsRes.body.ok ? metricsRes.body.data : undefined;
  const timeline = timelineRes.body.ok ? timelineRes.body.data : undefined;

  const addressLine = [customer.city, customer.state, customer.postalCode]
    .filter(Boolean)
    .join(', ');

  return (
    <section className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{customer.name}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {[customer.email, customer.phone].filter(Boolean).join(' · ') || 'No contact info'}
          </p>
          {(customer.addressLine1 || addressLine) && (
            <p className="text-sm text-slate-500">
              {[customer.addressLine1, addressLine].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={`/jobs/new?customerId=${customer.id}`}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            New job
          </Link>
          <Link href="/customers" className="text-sm text-slate-600 hover:underline">
            ← All customers
          </Link>
        </div>
      </div>

      {m && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard
            label="Lifetime revenue"
            value={money(m.lifetimeRevenueCents)}
            sub={`${m.paidInvoices} paid invoice${m.paidInvoices === 1 ? '' : 's'}`}
            tone="emerald"
          />
          <KpiCard
            label="Outstanding"
            value={money(m.outstandingCents)}
            sub={`${m.outstandingInvoices} unpaid`}
            tone={m.outstandingCents > 0 ? 'rose' : 'slate'}
          />
          <KpiCard
            label="Jobs & quotes"
            value={`${m.totalJobs} / ${m.totalQuotes}`}
            sub={`${m.openJobs} open jobs · ${m.conversionRatePct}% quote win`}
            tone="blue"
          />
          <KpiCard
            label="Avg order · recency"
            value={money(m.avgOrderValueCents)}
            sub={`Last job ${shortDate(m.lastJobAt)} · last contact ${shortDate(m.lastContactAt)}`}
          />
        </div>
      )}

      <CustomerActivity
        customerId={customer.id}
        initialRows={timeline?.rows ?? []}
        initialTotal={timeline?.total ?? 0}
      />

      <details className="rounded-lg border border-slate-200 bg-white">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-700">
          Edit customer details
        </summary>
        <div className="border-t border-slate-200 p-4">
          <EditCustomerForm customer={customer} />
        </div>
      </details>
    </section>
  );
}
