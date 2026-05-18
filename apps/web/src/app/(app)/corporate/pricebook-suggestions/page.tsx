import { apiServerFetch } from '../../../../lib/api.js';
import { SuggestionsTable, type SuggestionRow } from './SuggestionsTable';

interface SuggestionsPayload {
  rows: SuggestionRow[];
}

export default async function CorporatePricebookSuggestionsPage() {
  const res = await apiServerFetch<SuggestionsPayload>(
    '/api/v1/corporate/pricebook/suggestions',
    { cache: 'no-store' },
  );
  if (res.status !== 200 || !res.body.ok || !res.body.data) {
    return (
      <section>
        <h1 className="text-2xl font-semibold text-slate-900">
          Pricebook suggestions
        </h1>
        <p className="mt-2 text-sm text-rose-700">
          {res.body.error?.message ?? 'Unable to load suggestions.'}
        </p>
      </section>
    );
  }

  const rows = res.body.data.rows;
  const pending = rows.filter((r) => r.status === 'pending');
  const resolved = rows.filter((r) => r.status !== 'pending');

  return (
    <section>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">
          Pricebook suggestions
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Branch managers can suggest price changes from their pricebook. v1
          treats Approve / Reject as a paper trail — the corporate catalog is
          still edited via the catalog editor.
        </p>
      </header>

      <div className="space-y-8">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-600">
            Pending ({pending.length})
          </h2>
          <SuggestionsTable rows={pending} actionable />
        </div>

        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-600">
            Resolved ({resolved.length})
          </h2>
          <SuggestionsTable rows={resolved} actionable={false} />
        </div>
      </div>
    </section>
  );
}
