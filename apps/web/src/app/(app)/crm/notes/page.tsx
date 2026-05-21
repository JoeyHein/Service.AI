import { apiServerFetch } from '../../../../lib/api.js';
import { NotesFeed, type FeedRow } from './NotesFeed';

export default async function CrmNotesPage() {
  const res = await apiServerFetch<{ rows: FeedRow[]; total: number }>(
    '/api/v1/crm/notes-feed?limit=50',
  );
  const data = res.body.ok ? res.body.data : undefined;

  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">CRM Inbox</h1>
        <p className="mt-1 text-sm text-slate-500">
          Calls, emails, meetings and SMS logged across the business. Assign
          unmatched notes to a customer.
        </p>
      </div>
      <NotesFeed initialRows={data?.rows ?? []} initialTotal={data?.total ?? 0} />
    </section>
  );
}
