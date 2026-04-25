import Link from 'next/link';
import { apiServerFetch } from '../../../lib/api.js';
import { getSession } from '../../../lib/session.js';

interface Tiles {
  revenueCents: number;
  openArCents: number;
  jobsCompleted: number;
  bookingsFuture: number;
  avgTicketCents: number;
  voiceCalls: number;
  collectionsPending: number;
  emailsSent: number;
  smsSent: number;
}

interface AgingBuckets {
  current: number;
  d1to7: number;
  d8to14: number;
  d15to30: number;
  d31to60: number;
  d60plus: number;
}

interface QuotesPipeline {
  draft: number;
  finalized: number;
  sent: number;
  paid: number;
}

interface TechRow {
  techId: string;
  name: string;
  revenueCents: number;
  jobsCount: number;
}

interface CustomerRow {
  customerId: string;
  name: string;
  ltvCents: number;
  jobsCount: number;
}

interface RecentJob {
  jobId: string;
  customerName: string;
  status: string;
  scheduledStart: string | null;
  revenueCents: number;
}

interface Dashboard {
  period: { start: string; end: string; label: string };
  tiles: Tiles;
  agingBuckets: AgingBuckets;
  quotesPipeline: QuotesPipeline;
  topTechs: TechRow[];
  topCustomers: CustomerRow[];
  recentJobs: RecentJob[];
}

const PERIODS: Array<{ value: string; label: string }> = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'ytd', label: 'YTD' },
];

const DASHBOARD_ROLES = new Set([
  'platform_admin',
  'franchisor_admin',
  'franchisee_owner',
  'location_manager',
  'dispatcher',
]);

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

function statusPill(status: string): string {
  const base = 'inline-block rounded px-2 py-0.5 text-xs font-medium';
  switch (status) {
    case 'completed':
      return `${base} bg-emerald-100 text-emerald-700`;
    case 'scheduled':
      return `${base} bg-blue-100 text-blue-700`;
    case 'en_route':
    case 'arrived':
    case 'in_progress':
      return `${base} bg-amber-100 text-amber-700`;
    case 'unassigned':
      return `${base} bg-slate-100 text-slate-700`;
    case 'canceled':
      return `${base} bg-rose-100 text-rose-700`;
    default:
      return `${base} bg-slate-100 text-slate-700`;
  }
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const session = await getSession();
  const role = session?.scope?.role;
  const canSeeDashboard = role ? DASHBOARD_ROLES.has(role) : false;

  // Tech / CSR / unauth: render a friendly scope summary instead
  // of 403'ing, so the app still renders something useful.
  if (!canSeeDashboard) {
    return (
      <section>
        <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
        <p className="mt-1 text-sm text-slate-500">
          Welcome back{session?.user?.id ? `, ${session.user.id}` : ''}.
        </p>
        <div className="mt-6 bg-white rounded-lg border border-slate-200 p-6">
          <h2 className="text-sm font-medium text-slate-900 uppercase tracking-wide">
            Your scope
          </h2>
          <pre
            data-testid="scope-payload"
            className="mt-3 text-xs text-slate-700 bg-slate-50 rounded p-3 overflow-x-auto"
          >
            {JSON.stringify(session?.scope ?? null, null, 2)}
          </pre>
          {role === 'tech' && (
            <p className="mt-4 text-sm text-slate-600">
              <Link
                href="/tech"
                className="text-blue-700 hover:underline font-medium"
              >
                Go to Tech view →
              </Link>
            </p>
          )}
        </div>
      </section>
    );
  }

  const params = await searchParams;
  const period = ['7d', '30d', '90d', 'ytd'].includes(params.period ?? '')
    ? (params.period as string)
    : '30d';

  const res = await apiServerFetch<Dashboard>(
    `/api/v1/dashboard/owner?period=${period}`,
  );
  const d: Dashboard =
    res.body.ok && res.body.data
      ? res.body.data
      : {
          period: { start: '', end: '', label: period },
          tiles: {
            revenueCents: 0,
            openArCents: 0,
            jobsCompleted: 0,
            bookingsFuture: 0,
            avgTicketCents: 0,
            voiceCalls: 0,
            collectionsPending: 0,
            emailsSent: 0,
            smsSent: 0,
          },
          agingBuckets: {
            current: 0,
            d1to7: 0,
            d8to14: 0,
            d15to30: 0,
            d31to60: 0,
            d60plus: 0,
          },
          quotesPipeline: { draft: 0, finalized: 0, sent: 0, paid: 0 },
          topTechs: [],
          topCustomers: [],
          recentJobs: [],
        };

  const isEmpty =
    d.tiles.revenueCents === 0 &&
    d.tiles.jobsCompleted === 0 &&
    d.recentJobs.length === 0;

  return (
    <section>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
          <p className="mt-1 text-sm text-slate-500">
            Operational pulse for the trailing window.
          </p>
        </div>
        <nav
          aria-label="period"
          className="flex items-center gap-1 bg-white border border-slate-200 rounded-md p-1 text-sm"
          data-testid="period-picker"
        >
          {PERIODS.map((p) => (
            <Link
              key={p.value}
              href={`/dashboard?period=${p.value}`}
              className={`px-3 py-1 rounded ${
                period === p.value
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
              data-testid={`period-${p.value}`}
            >
              {p.label}
            </Link>
          ))}
        </nav>
      </div>

      {isEmpty && (
        <div className="mt-6 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-6 py-8 text-sm text-slate-600">
          <p className="font-medium text-slate-800">
            No activity yet in this window.
          </p>
          <p className="mt-2">
            Create a{' '}
            <Link href="/customers" className="text-blue-700 hover:underline">
              customer
            </Link>{' '}
            and a{' '}
            <Link href="/jobs" className="text-blue-700 hover:underline">
              job
            </Link>
            , close it out, and metrics will populate here. Operators can seed
            demo data by running <code>pnpm seed:demo</code>.
          </p>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile
          label="Revenue"
          value={money(d.tiles.revenueCents)}
          testId="tile-revenue"
        />
        <Tile
          label="Open AR"
          value={money(d.tiles.openArCents)}
          tone={d.tiles.openArCents > 0 ? 'warn' : 'default'}
          testId="tile-open-ar"
        />
        <Tile
          label="Jobs completed"
          value={String(d.tiles.jobsCompleted)}
          testId="tile-jobs-completed"
        />
        <Tile
          label="Avg ticket"
          value={money(d.tiles.avgTicketCents)}
          testId="tile-avg-ticket"
        />
        <Tile
          label="Future bookings"
          value={String(d.tiles.bookingsFuture)}
          tone="info"
          testId="tile-bookings-future"
        />
        <Tile
          label="Voice calls"
          value={String(d.tiles.voiceCalls)}
          testId="tile-voice-calls"
        />
        <Tile
          label="Collections pending"
          value={String(d.tiles.collectionsPending)}
          tone={d.tiles.collectionsPending > 0 ? 'warn' : 'default'}
          testId="tile-collections-pending"
          href={d.tiles.collectionsPending > 0 ? '/collections' : undefined}
        />
        <Tile
          label="Emails sent"
          value={String(d.tiles.emailsSent)}
          testId="tile-emails-sent"
        />
        <Tile
          label="SMS sent"
          value={String(d.tiles.smsSent)}
          testId="tile-sms-sent"
        />
        <Tile
          label="Period"
          value={d.period.label}
          tone="muted"
          testId="tile-period"
        />
      </div>

      <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel title="AR aging" testId="panel-aging">
          <AgingChart buckets={d.agingBuckets} />
        </Panel>
        <Panel title="Quotes & invoices pipeline" testId="panel-pipeline">
          <PipelineBar pipeline={d.quotesPipeline} />
        </Panel>
      </div>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel title="Top technicians (by revenue)" testId="panel-top-techs">
          {d.topTechs.length === 0 ? (
            <Empty>No completed jobs with assigned techs yet.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-1 font-medium">Tech</th>
                  <th className="py-1 font-medium text-right">Jobs</th>
                  <th className="py-1 font-medium text-right">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {d.topTechs.map((t) => (
                  <tr key={t.techId}>
                    <td className="py-2 text-slate-800">{t.name}</td>
                    <td className="py-2 text-right text-slate-600">
                      {t.jobsCount}
                    </td>
                    <td className="py-2 text-right text-slate-800 font-medium">
                      {money(t.revenueCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Top customers (lifetime value)" testId="panel-top-customers">
          {d.topCustomers.length === 0 ? (
            <Empty>No customer revenue recorded yet.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-1 font-medium">Customer</th>
                  <th className="py-1 font-medium text-right">Jobs</th>
                  <th className="py-1 font-medium text-right">LTV</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {d.topCustomers.map((c) => (
                  <tr key={c.customerId}>
                    <td className="py-2 text-slate-800">
                      <Link
                        href={`/customers/${c.customerId}`}
                        className="hover:underline"
                      >
                        {c.name}
                      </Link>
                    </td>
                    <td className="py-2 text-right text-slate-600">
                      {c.jobsCount}
                    </td>
                    <td className="py-2 text-right text-slate-800 font-medium">
                      {money(c.ltvCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel title="Recent jobs" testId="panel-recent-jobs" className="mt-6">
        {d.recentJobs.length === 0 ? (
          <Empty>
            <Link href="/jobs" className="text-blue-700 hover:underline">
              Create your first job →
            </Link>
          </Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-1 font-medium">Customer</th>
                <th className="py-1 font-medium">Status</th>
                <th className="py-1 font-medium">Scheduled</th>
                <th className="py-1 font-medium text-right">Revenue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {d.recentJobs.map((j) => (
                <tr key={j.jobId}>
                  <td className="py-2 text-slate-800">
                    <Link
                      href={`/jobs/${j.jobId}`}
                      className="hover:underline"
                    >
                      {j.customerName}
                    </Link>
                  </td>
                  <td className="py-2">
                    <span className={statusPill(j.status)}>{j.status}</span>
                  </td>
                  <td className="py-2 text-slate-600">
                    {j.scheduledStart
                      ? new Date(j.scheduledStart).toLocaleDateString()
                      : '—'}
                  </td>
                  <td className="py-2 text-right text-slate-800 font-medium">
                    {j.revenueCents > 0 ? money(j.revenueCents) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </section>
  );
}

function Tile({
  label,
  value,
  tone = 'default',
  testId,
  href,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warn' | 'info' | 'muted';
  testId?: string;
  href?: string;
}) {
  const toneClass =
    tone === 'warn'
      ? 'text-amber-700'
      : tone === 'info'
        ? 'text-blue-700'
        : tone === 'muted'
          ? 'text-slate-500'
          : 'text-slate-900';
  const body = (
    <div
      className="bg-white rounded-lg border border-slate-200 px-4 py-4"
      data-testid={testId}
    >
      <div className="text-xs uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className={`mt-2 text-2xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

function Panel({
  title,
  children,
  className = '',
  testId,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={`bg-white rounded-lg border border-slate-200 p-4 ${className}`}
      data-testid={testId}
    >
      <h2 className="text-sm font-medium text-slate-900 uppercase tracking-wide mb-3">
        {title}
      </h2>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-sm text-slate-500 py-4">{children}</div>;
}

const AGING_COLORS: Record<keyof AgingBuckets, string> = {
  current: 'bg-emerald-500',
  d1to7: 'bg-yellow-400',
  d8to14: 'bg-amber-500',
  d15to30: 'bg-orange-500',
  d31to60: 'bg-rose-500',
  d60plus: 'bg-rose-700',
};

const AGING_LABELS: Record<keyof AgingBuckets, string> = {
  current: 'Current',
  d1to7: '1–7d',
  d8to14: '8–14d',
  d15to30: '15–30d',
  d31to60: '31–60d',
  d60plus: '60d+',
};

function AgingChart({ buckets }: { buckets: AgingBuckets }) {
  const total =
    buckets.current +
    buckets.d1to7 +
    buckets.d8to14 +
    buckets.d15to30 +
    buckets.d31to60 +
    buckets.d60plus;
  if (total === 0) {
    return (
      <Empty>No open invoices — every finalized invoice has been paid.</Empty>
    );
  }
  const order: (keyof AgingBuckets)[] = [
    'current',
    'd1to7',
    'd8to14',
    'd15to30',
    'd31to60',
    'd60plus',
  ];
  return (
    <div className="text-sm" data-testid="aging-chart">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
        {order.map((k) => {
          const v = buckets[k];
          if (v === 0) return null;
          const pct = (v / total) * 100;
          return (
            <div
              key={k}
              className={AGING_COLORS[k]}
              style={{ width: `${pct}%` }}
              title={`${AGING_LABELS[k]}: ${(v / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}`}
            />
          );
        })}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
        {order.map((k) => (
          <li
            key={k}
            className="flex items-center justify-between text-slate-600"
            data-testid={`aging-row-${k}`}
          >
            <span className="flex items-center gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${AGING_COLORS[k]}`}
              />
              {AGING_LABELS[k]}
            </span>
            <span className="font-medium text-slate-800">
              {money(buckets[k])}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PipelineBar({ pipeline }: { pipeline: QuotesPipeline }) {
  const order: Array<{ key: keyof QuotesPipeline; label: string; color: string }> = [
    { key: 'draft', label: 'Quotes (draft)', color: 'bg-slate-400' },
    { key: 'finalized', label: 'Finalized', color: 'bg-blue-400' },
    { key: 'sent', label: 'Sent', color: 'bg-amber-500' },
    { key: 'paid', label: 'Paid', color: 'bg-emerald-500' },
  ];
  const total = order.reduce((acc, s) => acc + pipeline[s.key], 0);
  if (total === 0) {
    return <Empty>No invoices yet.</Empty>;
  }
  return (
    <div className="text-sm" data-testid="pipeline-bar">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
        {order.map((s) => {
          const v = pipeline[s.key];
          if (v === 0) return null;
          const pct = (v / total) * 100;
          return (
            <div
              key={s.key}
              className={s.color}
              style={{ width: `${pct}%` }}
              title={`${s.label}: ${v}`}
            />
          );
        })}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
        {order.map((s) => (
          <li
            key={s.key}
            className="flex items-center justify-between text-slate-600"
            data-testid={`pipeline-row-${s.key}`}
          >
            <span className="flex items-center gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${s.color}`}
              />
              {s.label}
            </span>
            <span className="font-medium text-slate-800">
              {pipeline[s.key]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
