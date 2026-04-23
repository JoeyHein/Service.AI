import Link from 'next/link';
import { apiServerFetch } from '../../lib/api.js';
import { getSession } from '../../lib/session.js';

interface JobRow {
  id: string;
  title: string;
  status: string;
  customerId: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
}

interface JobsPayload {
  rows: JobRow[];
  total: number;
}

const ACTIVE_STATUSES = new Set([
  'unassigned',
  'scheduled',
  'en_route',
  'arrived',
  'in_progress',
]);

/**
 * Today's jobs for the signed-in tech. Filters server-side by
 * assignedTechUserId = session.user.id and client-side drops anything
 * already completed / canceled so the screen stays focused on what's
 * left to do. Sorted by scheduled start (nulls last) so the next call
 * is first.
 */
export default async function TechTodayPage() {
  const session = await getSession();
  const me = session?.user.id;
  const params = new URLSearchParams();
  params.set('limit', '50');
  if (me) params.set('assignedTechUserId', me);
  const res = await apiServerFetch<JobsPayload>(`/api/v1/jobs?${params.toString()}`);
  const all =
    res.status === 200 && res.body.ok && res.body.data ? res.body.data.rows : [];
  const active = all
    .filter((j) => ACTIVE_STATUSES.has(j.status))
    .sort((a, b) => {
      const ax = a.scheduledStart ? Date.parse(a.scheduledStart) : Infinity;
      const bx = b.scheduledStart ? Date.parse(b.scheduledStart) : Infinity;
      return ax - bx;
    });

  return (
    <section data-testid="tech-today">
      <h1 className="text-xl font-semibold text-slate-900">Today</h1>
      <p className="mt-1 text-sm text-slate-500">
        {active.length === 0
          ? 'Nothing on your list yet.'
          : `${active.length} active ${active.length === 1 ? 'job' : 'jobs'}`}
      </p>
      <ul className="mt-4 space-y-2">
        {active.map((j) => (
          <li key={j.id}>
            <Link
              href={`/tech/jobs/${j.id}`}
              className="block rounded-lg border border-slate-200 bg-white p-3 active:bg-slate-100"
              data-testid="tech-job-card"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-medium text-slate-900">{j.title}</h2>
                <span className="text-xs font-mono text-slate-500 shrink-0">
                  {j.status}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {j.scheduledStart
                  ? new Date(j.scheduledStart).toLocaleString()
                  : 'unscheduled'}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
