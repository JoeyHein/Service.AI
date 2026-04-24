import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { apiServerFetch } from '../../../../lib/api.js';
import { getSession } from '../../../../lib/session.js';
import { AuditLogTable, type AuditRow } from './AuditLogTable';

interface AuditLogResponse {
  rows: AuditRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Audit log viewer (TEN-08). Server component fetches a filtered,
 * paginated slice of audit_log and renders a table with inline
 * filter controls. Platform admin and franchisor admin can access;
 * every other scope type hits notFound() so the route's existence
 * is not leaked.
 *
 * Search query params → API query params (1:1). Filters combine via
 * WHERE ... AND ... on the API side. `from`/`to` are ISO dates;
 * empty strings are ignored. Pagination is offset-based; offset
 * increments by `limit` per page.
 */
export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (
    !session ||
    (session.scope?.type !== 'platform' && session.scope?.type !== 'franchisor')
  ) {
    notFound();
  }

  const params = await searchParams;
  const one = (key: string) => {
    const v = params[key];
    return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
  };

  const actorEmail = one('actorEmail') ?? '';
  const franchiseeId = one('franchiseeId') ?? '';
  const action = one('action') ?? '';
  const fromDate = one('fromDate') ?? '';
  const toDate = one('toDate') ?? '';
  const q_search = one('q') ?? '';
  const kind = one('kind') ?? '';
  const page = Math.max(parseInt(one('page') ?? '1', 10) || 1, 1);
  const limit = 50;
  const offset = (page - 1) * limit;

  const q = new URLSearchParams();
  q.set('limit', String(limit));
  q.set('offset', String(offset));
  if (actorEmail) q.set('actorEmail', actorEmail);
  if (franchiseeId) q.set('franchiseeId', franchiseeId);
  if (action) q.set('action', action);
  if (fromDate) q.set('fromDate', fromDate);
  if (toDate) q.set('toDate', toDate);
  if (q_search) q.set('q', q_search);
  if (kind) q.set('kind', kind);

  const res = await apiServerFetch<AuditLogResponse>(
    `/api/v1/audit-log?${q.toString()}`,
  );
  const data =
    res.body.ok && res.body.data
      ? res.body.data
      : { rows: [], total: 0, limit, offset };

  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">Audit log</h1>
      <p className="mt-1 text-sm text-slate-500">
        {data.total === 0
          ? 'No audit entries match your filters.'
          : `Showing ${data.rows.length} of ${data.total} entries.`}
      </p>

      <form
        method="get"
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5 bg-white rounded-lg border border-slate-200 p-4"
      >
        <label className="block text-sm">
          <span className="text-slate-700 font-medium">Search</span>
          <input
            name="q"
            type="text"
            defaultValue={q_search}
            placeholder="keyword"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-700 font-medium">Kind</span>
          <select
            name="kind"
            defaultValue={kind}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">All</option>
            <option value="impersonation">Impersonation</option>
            <option value="invoice">Invoice</option>
            <option value="payment">Payment</option>
            <option value="agreement">Agreement</option>
            <option value="onboard">Onboarding</option>
            <option value="catalog">Catalog</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-slate-700 font-medium">Actor email</span>
          <input
            name="actorEmail"
            type="text"
            defaultValue={actorEmail}
            placeholder="admin@…"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-700 font-medium">Action</span>
          <input
            name="action"
            type="text"
            defaultValue={action}
            placeholder="impersonate.request"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-700 font-medium">Franchisee id</span>
          <input
            name="franchiseeId"
            type="text"
            defaultValue={franchiseeId}
            placeholder="uuid"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-700 font-medium">From (ISO)</span>
          <input
            name="fromDate"
            type="datetime-local"
            defaultValue={fromDate}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-700 font-medium">To (ISO)</span>
          <input
            name="toDate"
            type="datetime-local"
            defaultValue={toDate}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <div className="sm:col-span-2 lg:col-span-5 flex gap-2 justify-end">
          <a
            href="/franchisor/audit"
            className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            Reset
          </a>
          <button
            type="submit"
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Apply
          </button>
        </div>
      </form>

      <div className="mt-6">
        <Suspense fallback={<div>Loading…</div>}>
          <AuditLogTable
            rows={data.rows}
            total={data.total}
            limit={data.limit}
            offset={data.offset}
            currentPage={page}
            filters={{
              actorEmail,
              franchiseeId,
              action,
              fromDate,
              toDate,
              q: q_search,
              kind,
            }}
          />
        </Suspense>
      </div>
    </section>
  );
}
