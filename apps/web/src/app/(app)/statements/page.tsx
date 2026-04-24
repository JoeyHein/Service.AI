import { apiServerFetch } from '../../../lib/api.js';
import { StatementsList } from '../franchisor/franchisees/[id]/statements/StatementsList';

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

/**
 * Franchisee-scoped self-view. Shows only the caller's own
 * royalty statements. Reuses the shared StatementsList component
 * in non-admin mode (no Generate button, no Reconcile action).
 */
export default async function MyStatementsPage() {
  const res = await apiServerFetch<{ rows: Statement[] }>('/api/v1/statements');
  const rows = res.status === 200 && res.body.data ? res.body.data.rows : [];

  const ytdCollected = rows.reduce((acc, s) => acc + Number(s.royaltyCollected), 0);
  const ytdGross = rows.reduce((acc, s) => acc + Number(s.grossRevenue), 0);

  return (
    <section>
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">My statements</h1>
        <p className="mt-1 text-sm text-slate-500">
          Royalty statements for your franchisee.
        </p>
      </div>

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <SummaryTile label="Year-to-date gross" value={ytdGross} />
        <SummaryTile label="Year-to-date royalty" value={ytdCollected} />
      </div>

      <StatementsList initial={rows} />
    </section>
  );
}

function SummaryTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs text-slate-500 uppercase tracking-wide">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-900">
        {value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
      </p>
    </div>
  );
}
