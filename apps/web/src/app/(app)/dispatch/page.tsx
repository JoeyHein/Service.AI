import { notFound } from 'next/navigation';
import { apiServerFetch } from '../../../lib/api.js';
import { getSession } from '../../../lib/session.js';
import { DispatchBoard, type JobCard, type Tech } from './DispatchBoard';
import { AiSuggestionsPanel } from './AiSuggestionsPanel';

interface Suggestion {
  id: string;
  subjectJobId: string;
  proposedTechUserId: string | null;
  proposedScheduledStart: string | null;
  reasoning: string;
  confidence: string;
  status: string;
}

interface JobsPayload {
  rows: Array<{
    id: string;
    title: string;
    status: string;
    customerId: string;
    assignedTechUserId: string | null;
    scheduledStart: string | null;
  }>;
  total: number;
}

export default async function DispatchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  // The dispatch board operates inside one franchisee at a time.
  // Franchisee-scoped callers see their own; platform / franchisor
  // admins not currently impersonating would need to pick one — for
  // v1 they hit notFound() and can use impersonation to enter a
  // franchisee's context.
  if (!session || session.scope?.type !== 'franchisee') {
    notFound();
  }

  const params = await searchParams;
  const one = (k: string) => {
    const v = params[k];
    return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
  };
  const date = one('date') ?? new Date().toISOString().slice(0, 10);

  const [techsRes, jobsRes, suggestionsRes] = await Promise.all([
    apiServerFetch<Tech[]>('/api/v1/techs'),
    // Fetch both unassigned (regardless of date) and scheduled/en_route
    // jobs — the board shows active work. Filter further client-side if
    // a date is set; we pull a generous slice here.
    apiServerFetch<JobsPayload>('/api/v1/jobs?limit=200'),
    apiServerFetch<{ rows: Suggestion[] }>(
      '/api/v1/dispatch/suggestions?status=pending',
    ),
  ]);

  const techs: Tech[] = techsRes.body.ok && techsRes.body.data ? techsRes.body.data : [];
  const allJobs = jobsRes.body.ok && jobsRes.body.data ? jobsRes.body.data.rows : [];
  const suggestions: Suggestion[] =
    suggestionsRes.body.ok && suggestionsRes.body.data
      ? suggestionsRes.body.data.rows
      : [];
  const techsById = Object.fromEntries(
    techs.map((t) => [t.userId, t.name ?? t.email ?? t.userId]),
  );

  // Keep jobs that are unassigned OR scheduled for the selected date,
  // OR en_route / arrived / in_progress (active today regardless of
  // scheduled_start drift). Terminal statuses are hidden.
  const visible: JobCard[] = allJobs
    .filter((j) => {
      if (j.status === 'completed' || j.status === 'canceled') return false;
      if (j.status === 'unassigned') return true;
      if (['en_route', 'arrived', 'in_progress'].includes(j.status)) return true;
      // scheduled — only if scheduled_start is the selected day
      if (j.status === 'scheduled') {
        if (!j.scheduledStart) return true;
        return j.scheduledStart.slice(0, 10) === date;
      }
      return false;
    })
    .map((j) => ({
      id: j.id,
      title: j.title,
      status: j.status,
      assignedTechUserId: j.assignedTechUserId,
      scheduledStart: j.scheduledStart,
    }));

  return (
    <section>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Dispatch</h1>
          <p className="mt-1 text-sm text-slate-500">
            Drag jobs onto a tech to assign. Updates propagate live across
            sessions.
          </p>
        </div>
        <form method="get" className="flex items-center gap-2">
          <label className="text-sm text-slate-600">Date</label>
          <input
            type="date"
            name="date"
            defaultValue={date}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
          <button
            type="submit"
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Apply
          </button>
        </form>
      </div>
      <div className="mt-6 flex gap-4 items-start">
        <div className="flex-1 min-w-0">
          <DispatchBoard initialJobs={visible} techs={techs} />
        </div>
        <AiSuggestionsPanel initial={suggestions} techsById={techsById} />
      </div>
    </section>
  );
}
