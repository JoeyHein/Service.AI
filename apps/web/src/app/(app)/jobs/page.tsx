import Link from 'next/link';
import { apiServerFetch } from '../../../lib/api.js';

interface JobRow {
  id: string;
  title: string;
  status: string;
  customerId: string;
  scheduledStart: string | null;
  createdAt: string;
}

interface JobsPayload {
  rows: JobRow[];
  total: number;
  limit: number;
  offset: number;
}

const LIMIT = 50;

const STATUSES = [
  'unassigned',
  'scheduled',
  'en_route',
  'arrived',
  'in_progress',
  'completed',
  'canceled',
] as const;

export default async function JobsPage({
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
  const customerId = one('customerId') ?? '';
  const page = Math.max(parseInt(one('page') ?? '1', 10) || 1, 1);
  const offset = (page - 1) * LIMIT;

  const q = new URLSearchParams();
  q.set('limit', String(LIMIT));
  q.set('offset', String(offset));
  if (status) q.set('status', status);
  if (customerId) q.set('customerId', customerId);
  const res = await apiServerFetch<JobsPayload>(`/api/v1/jobs?${q.toString()}`);
  const data =
    res.body.ok && res.body.data
      ? res.body.data
      : { rows: [], total: 0, limit: LIMIT, offset };
  const totalPages = Math.max(Math.ceil(data.total / LIMIT), 1);

  function pageLink(p: number): string {
    const qs = new URLSearchParams();
    qs.set('page', String(p));
    if (status) qs.set('status', status);
    if (customerId) qs.set('customerId', customerId);
    return `/jobs?${qs.toString()}`;
  }

  return (
    <section>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Jobs</h1>
          <p className="mt-1 text-sm text-slate-500">
            {data.total === 0 ? 'No jobs yet.' : `${data.rows.length} of ${data.total}`}
          </p>
        </div>
        <Link
          href="/jobs/new"
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          New job
        </Link>
      </div>

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
        data-testid="jobs-list"
        className="mt-6 bg-white rounded-lg border border-slate-200 overflow-hidden"
      >
        {data.rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-500">
            No jobs match.
          </div>
        ) : (
          <table className="min-w-full text-sm divide-y divide-slate-200">
            <thead className="bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Scheduled</th>
                <th className="px-4 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map((j) => (
                <tr key={j.id}>
                  <td className="px-4 py-2">
                    <Link
                      href={`/jobs/${j.id}`}
                      className="font-medium text-blue-700 hover:underline"
                    >
                      {j.title}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-xs font-mono">{j.status}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {j.scheduledStart
                      ? new Date(j.scheduledStart).toLocaleString()
                      : '—'}
                  </td>
                  <td className="px-4 py-2 text-slate-500">
                    {new Date(j.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {totalPages > 1 && (
        <nav className="mt-4 flex items-center justify-between text-sm">
          <span className="text-slate-500">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            <Link
              href={pageLink(Math.max(page - 1, 1))}
              aria-disabled={page <= 1}
              className={`rounded border px-3 py-1 ${page <= 1 ? 'border-slate-200 text-slate-300 pointer-events-none' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}
            >
              Previous
            </Link>
            <Link
              href={pageLink(Math.min(page + 1, totalPages))}
              aria-disabled={page >= totalPages}
              className={`rounded border px-3 py-1 ${page >= totalPages ? 'border-slate-200 text-slate-300 pointer-events-none' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}
            >
              Next
            </Link>
          </div>
        </nav>
      )}
    </section>
  );
}
