import Link from 'next/link';

export interface AuditRow {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  targetFranchiseeId: string | null;
  action: string;
  scopeType: string | null;
  scopeId: string | null;
  metadata: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

interface Filters {
  actorEmail: string;
  franchiseeId: string;
  action: string;
  fromDate: string;
  toDate: string;
  q: string;
  kind: string;
}

function pageLink(page: number, filters: Filters): string {
  const q = new URLSearchParams();
  q.set('page', String(page));
  for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
  return `/franchisor/audit?${q.toString()}`;
}

function formatDate(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

export function AuditLogTable({
  rows,
  total,
  limit,
  currentPage,
  filters,
}: {
  rows: AuditRow[];
  total: number;
  limit: number;
  offset: number;
  currentPage: number;
  filters: Filters;
}) {
  const totalPages = Math.max(Math.ceil(total / limit), 1);
  const hasPrev = currentPage > 1;
  const hasNext = currentPage < totalPages;

  if (rows.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-slate-200 px-4 py-8 text-center text-sm text-slate-500">
        No entries to show.
      </div>
    );
  }

  return (
    <>
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <table
          data-testid="audit-log-table"
          className="min-w-full text-sm divide-y divide-slate-200"
        >
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-4 py-2 font-medium">Time</th>
              <th className="px-4 py-2 font-medium">Actor</th>
              <th className="px-4 py-2 font-medium">Action</th>
              <th className="px-4 py-2 font-medium">Target franchisee</th>
              <th className="px-4 py-2 font-medium">Metadata</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="px-4 py-2 text-slate-500 whitespace-nowrap">
                  {formatDate(r.createdAt)}
                </td>
                <td className="px-4 py-2 text-slate-800">
                  {r.actorEmail ?? r.actorUserId ?? '—'}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-slate-800">
                  {r.action}
                </td>
                <td className="px-4 py-2 text-slate-500 font-mono text-xs">
                  {r.targetFranchiseeId ?? '—'}
                </td>
                <td className="px-4 py-2 text-slate-500 font-mono text-xs">
                  <pre className="whitespace-pre-wrap">
                    {JSON.stringify(r.metadata, null, 0)}
                  </pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <nav
        className="mt-4 flex items-center justify-between text-sm"
        aria-label="audit pagination"
      >
        <span className="text-slate-500">
          Page {currentPage} of {totalPages}
        </span>
        <div className="flex gap-2">
          <Link
            href={pageLink(Math.max(currentPage - 1, 1), filters)}
            aria-disabled={!hasPrev}
            className={`rounded border px-3 py-1 ${
              hasPrev
                ? 'border-slate-300 text-slate-700 hover:bg-slate-50'
                : 'border-slate-200 text-slate-300 pointer-events-none'
            }`}
          >
            Previous
          </Link>
          <Link
            href={pageLink(Math.min(currentPage + 1, totalPages), filters)}
            aria-disabled={!hasNext}
            className={`rounded border px-3 py-1 ${
              hasNext
                ? 'border-slate-300 text-slate-700 hover:bg-slate-50'
                : 'border-slate-200 text-slate-300 pointer-events-none'
            }`}
          >
            Next
          </Link>
        </div>
      </nav>
    </>
  );
}
