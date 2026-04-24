import { notFound } from 'next/navigation';
import Link from 'next/link';
import { apiServerFetch } from '../../../../../../lib/api.js';
import { getSession } from '../../../../../../lib/session.js';
import { ConnectOnboardingPanel } from './ConnectOnboardingPanel';

interface ConnectStatus {
  accountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

interface Franchisee {
  id: string;
  name: string;
  slug: string;
  franchisorId: string;
}

/**
 * Franchisor-admin-only billing / Connect page. Shows current
 * onboarding status and exposes the "Start / resume onboarding"
 * button that calls POST /connect/onboard to fetch a fresh
 * account-link URL.
 */
export default async function FranchiseeBillingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();
  if (
    !session ||
    (session.scope?.type !== 'platform' && session.scope?.type !== 'franchisor')
  ) {
    notFound();
  }

  const feRes = await apiServerFetch<Franchisee[]>('/api/v1/franchisees');
  const fe =
    feRes.status === 200 && feRes.body.data
      ? feRes.body.data.find((f) => f.id === id) ?? null
      : null;
  if (!fe) notFound();

  const statusRes = await apiServerFetch<ConnectStatus>(
    `/api/v1/franchisees/${encodeURIComponent(id)}/connect/status`,
  );
  const status =
    statusRes.status === 200 && statusRes.body.data ? statusRes.body.data : null;

  return (
    <section>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            {fe.name} — Billing
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Stripe Connect Standard onboarding &amp; payout readiness.
          </p>
        </div>
        <Link
          href="/franchisor/franchisees"
          className="text-sm text-slate-600 hover:underline"
        >
          ← All franchisees
        </Link>
      </div>

      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-medium text-slate-700">Current status</h2>
        {status === null ? (
          <p className="mt-2 text-sm text-slate-500">
            Could not load Connect status.
          </p>
        ) : (
          <dl className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <StatusRow
              label="Details submitted"
              value={status.detailsSubmitted}
            />
            <StatusRow
              label="Charges enabled"
              value={status.chargesEnabled}
            />
            <StatusRow
              label="Payouts enabled"
              value={status.payoutsEnabled}
            />
          </dl>
        )}
        {status?.accountId && (
          <p className="mt-3 text-xs text-slate-500 font-mono">
            Account: {status.accountId}
          </p>
        )}
      </div>

      <div className="mt-4">
        <ConnectOnboardingPanel franchiseeId={fe.id} status={status} />
      </div>
    </section>
  );
}

function StatusRow({ label, value }: { label: string; value: boolean }) {
  return (
    <div className="flex items-center justify-between rounded border border-slate-200 px-3 py-2">
      <span className="text-slate-600">{label}</span>
      <span
        className={
          value
            ? 'text-green-700 text-xs font-medium uppercase tracking-wide'
            : 'text-slate-400 text-xs font-medium uppercase tracking-wide'
        }
      >
        {value ? 'ready' : 'pending'}
      </span>
    </div>
  );
}
