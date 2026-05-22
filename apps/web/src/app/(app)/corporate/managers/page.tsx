import { apiServerFetch } from '../../../../lib/api.js';
import { InviteManager, type BranchOption } from './InviteManager';

interface ManagerRow {
  userId: string;
  name: string | null;
  email: string;
  branchId: string | null;
  branchName: string | null;
  compPlanId: string | null;
  compPlanName: string | null;
  currentPeriodTotalCents: number;
}

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

export default async function ManagersPage() {
  const [res, branchRes] = await Promise.all([
    apiServerFetch<ManagerRow[]>('/api/v1/corporate/managers'),
    apiServerFetch<BranchOption[]>('/api/v1/corporate/branches'),
  ]);
  const rows = res.body.ok && res.body.data ? res.body.data : [];
  const branches = branchRes.body.ok ? (branchRes.body.data ?? []) : [];

  return (
    <section>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Managers</h1>
          <p className="mt-1 text-sm text-slate-500">
            {rows.length === 0
              ? 'No managers yet.'
              : `${rows.length} manager${rows.length === 1 ? '' : 's'} in the network.`}
          </p>
        </div>
      </div>

      <InviteManager branches={branches} />

      <div
        data-testid="managers-table"
        className="mt-6 overflow-hidden rounded-lg border border-slate-200 bg-white"
      >
        <table className="min-w-full text-sm divide-y divide-slate-200">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Branch</th>
              <th className="px-3 py-2 font-medium">Comp plan</th>
              <th className="px-3 py-2 font-medium text-right">
                Period total
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-slate-500">
                  Nothing to show.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.userId}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-800">
                      {r.name ?? r.email}
                    </div>
                    <div className="text-xs text-slate-500">{r.email}</div>
                  </td>
                  <td className="px-3 py-2 text-slate-700">
                    {r.branchName ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-700">
                    {r.compPlanName ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {money(r.currentPeriodTotalCents)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
