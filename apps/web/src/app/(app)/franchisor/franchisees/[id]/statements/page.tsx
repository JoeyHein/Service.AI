import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiServerFetch } from '../../../../../../lib/api.js';
import { getSession } from '../../../../../../lib/session.js';
import { StatementsList } from './StatementsList';

interface Statement {
  id: string;
  periodStart: string;
  periodEnd: string;
  grossRevenue: string;
  refundTotal: string;
  netRevenue: string;
  royaltyOwed: string;
  royaltyCollected: string;
  variance: string;
  status: string;
  transferId: string | null;
}

interface Franchisee {
  id: string;
  name: string;
  slug: string;
  franchisorId: string;
}

export default async function StatementsPage({
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

  const res = await apiServerFetch<{ rows: Statement[] }>(
    `/api/v1/franchisees/${encodeURIComponent(id)}/statements`,
  );
  const rows =
    res.status === 200 && res.body.data ? res.body.data.rows : [];

  return (
    <section>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            {fe.name} — Statements
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Monthly royalty statements. Reconciled via Stripe Transfers.
          </p>
        </div>
        <Link
          href={`/franchisor/franchisees/${id}/agreement`}
          className="text-sm text-slate-600 hover:underline"
        >
          Agreement →
        </Link>
      </div>
      <StatementsList franchiseeId={fe.id} initial={rows} adminView />
    </section>
  );
}
