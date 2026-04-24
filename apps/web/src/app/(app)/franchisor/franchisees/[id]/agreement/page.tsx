import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiServerFetch } from '../../../../../../lib/api.js';
import { getSession } from '../../../../../../lib/session.js';
import { AgreementEditor, type AgreementPayload } from './AgreementEditor';

interface Franchisee {
  id: string;
  name: string;
  slug: string;
  franchisorId: string;
}

/**
 * Franchisor-admin page to create / edit / activate an agreement.
 * Active agreements are read-only; the client either seeds a new
 * draft or edits an existing draft's rule array.
 */
export default async function AgreementPage({
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

  const res = await apiServerFetch<AgreementPayload | null>(
    `/api/v1/franchisees/${encodeURIComponent(id)}/agreement`,
  );
  const agreement = res.status === 200 && res.body.ok ? res.body.data ?? null : null;

  return (
    <section>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            {fe.name} — Agreement
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Rules resolve the application fee on every finalised invoice.
          </p>
        </div>
        <Link
          href={`/franchisor/franchisees/${id}/billing`}
          className="text-sm text-slate-600 hover:underline"
        >
          ← Billing
        </Link>
      </div>

      <AgreementEditor franchiseeId={fe.id} initial={agreement} />
    </section>
  );
}
