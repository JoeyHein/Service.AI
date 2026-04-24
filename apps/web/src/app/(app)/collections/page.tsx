import { notFound } from 'next/navigation';
import { apiServerFetch } from '../../../lib/api.js';
import { getSession } from '../../../lib/session.js';
import { CollectionsQueue } from './CollectionsQueue';

interface Draft {
  id: string;
  invoiceId: string;
  tone: 'friendly' | 'firm' | 'final';
  status: 'pending' | 'approved' | 'edited' | 'rejected' | 'sent' | 'failed';
  smsBody: string;
  emailSubject: string;
  emailBody: string;
  createdAt: string;
}

interface Metrics {
  dsoDays: number;
  recoveredRevenueCents: number;
  openInvoiceCents: number;
  totalRevenueCents: number;
}

const COLLECTIONS_ROLES = new Set([
  'franchisee_owner',
  'location_manager',
  'dispatcher',
]);

export default async function CollectionsPage() {
  const session = await getSession();
  if (!session) notFound();
  const scope = session.scope;
  if (!scope || scope.type === 'platform' || scope.type === 'franchisor') {
    notFound();
  }
  if (scope.type === 'franchisee' && !COLLECTIONS_ROLES.has(scope.role)) {
    notFound();
  }

  const [draftsRes, metricsRes] = await Promise.all([
    apiServerFetch<{ rows: Draft[] }>(
      '/api/v1/collections/drafts?status=pending',
    ),
    apiServerFetch<Metrics>('/api/v1/collections/metrics'),
  ]);
  const drafts: Draft[] =
    draftsRes.body.ok && draftsRes.body.data ? draftsRes.body.data.rows : [];
  const metrics: Metrics | null =
    metricsRes.body.ok && metricsRes.body.data ? metricsRes.body.data : null;

  return (
    <section>
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Collections</h1>
        <p className="mt-1 text-sm text-slate-500">
          AI-drafted reminders for past-due invoices. Approve, edit, or reject each.
        </p>
      </div>

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Tile
          label="DSO (30-day)"
          value={metrics ? `${metrics.dsoDays} days` : '—'}
        />
        <Tile
          label="Open receivables"
          value={
            metrics
              ? `$${(metrics.openInvoiceCents / 100).toLocaleString('en-US')}`
              : '—'
          }
        />
        <Tile
          label="Recovered via retries"
          value={
            metrics
              ? `$${(metrics.recoveredRevenueCents / 100).toLocaleString('en-US')}`
              : '—'
          }
        />
      </div>

      <div className="mt-6">
        <CollectionsQueue initial={drafts} />
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
