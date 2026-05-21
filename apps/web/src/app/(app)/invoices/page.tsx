import Link from 'next/link';
import { apiServerFetch } from '../../../lib/api.js';

interface InvoiceRow {
  id: string;
  status: string;
  total: string;
  quoteId: string | null;
  jobId: string;
  customerName: string;
  jobTitle: string;
  paidAt: string | null;
  createdAt: string;
}

const LIMIT = 50;
const STATUSES = ['draft', 'finalized', 'sent', 'paid', 'void'] as const;

function money(v: string): string {
  return Number(v).toLocaleString('en-US', { style: 'currency', currency: 'CAD' });
}

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700',
  finalized: 'bg-amber-100 text-amber-800',
  sent: 'bg-blue-100 text-blue-800',
  paid: 'bg-emerald-100 text-emerald-800',
  void: 'bg-rose-100 text-rose-700',
};

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (k: string) => {
    const v = params[k];
    return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
  };
  const status = one('status') ?? '';
  const page = Math.max(parseInt(one('page') ?? '1', 10) || 1, 1);
  const offset = (page - 1) * LIMIT;

  const q = new URLSearchParams();
  q.set('limit', String(LIMIT));
  q.set('offset', String(offset));
  if (status) q.set('status', status);
  const res = await apiServerFetch<InvoiceRow[]>(`/api/v1/invoices?${q.toString()}`);
  const rows = res.body.ok && res.body.data ? res.body.data : [];

  function pageLink(p: number): string {
    const qs = new URLSearchParams();
    qs.set('page', String(p));
    if (status) qs.set('status', status);
    return `/invoices?${qs.toString()}`;
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">Invoices</h1>
      <p className="mt-1 text-sm text-slate-500">
        {rows.length === 0 ? 'No invoices.' : `${rows.length} invoice(s)`}
      </p>

      <form method="get" className="mt-4 flex flex-wrap gap-2">
        <select
          name="status"
          defaultValue={status}
          className="rounded border border-slate-300 px-2 py-1.5 text-sm"
        >
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Filter
        </button>
      </form>

      <div
        data-testid="invoices-list"
        className="mt-6 bg-white rounded-lg border border-slate-200 overflow-hidden"
      >
        {rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-500">No invoices match.</div>
        ) : (
          <table className="min-w-full text-sm divide-y divide-slate-200">
            <thead className="bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-4 py-2 font-medium">Customer / Job</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium text-right">Total</th>
                <th className="px-4 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((inv) => (
                <tr key={inv.id}>
                  <td className="px-4 py-2">
                    <Link
                      href={`/invoices/${inv.id}`}
                      className="font-medium text-blue-700 hover:underline"
                    >
                      {inv.customerName}
                    </Link>
                    <div className="text-xs text-slate-500">{inv.jobTitle}</div>
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[inv.status] ?? 'bg-slate-100 text-slate-700'}`}
                    >
                      {inv.status}
                    </span>
                    {inv.quoteId && (
                      <span className="ml-1 inline-block rounded bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
                        balance
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">{money(inv.total)}</td>
                  <td className="px-4 py-2 text-slate-500">
                    {new Date(inv.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(page > 1 || rows.length === LIMIT) && (
        <nav className="mt-4 flex items-center justify-end gap-2 text-sm">
          <Link
            href={pageLink(Math.max(page - 1, 1))}
            aria-disabled={page <= 1}
            className={`rounded border px-3 py-1 ${page <= 1 ? 'border-slate-200 text-slate-300 pointer-events-none' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}
          >
            Previous
          </Link>
          <Link
            href={pageLink(page + 1)}
            aria-disabled={rows.length < LIMIT}
            className={`rounded border px-3 py-1 ${rows.length < LIMIT ? 'border-slate-200 text-slate-300 pointer-events-none' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}
          >
            Next
          </Link>
        </nav>
      )}
    </section>
  );
}
