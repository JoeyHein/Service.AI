import { notFound } from 'next/navigation';
import { apiServerFetch } from '../../../../../lib/api.js';
import { CompPlanForm } from '../CompPlanForm';

interface CompPlanDetail {
  plan: {
    id: string;
    name: string;
    kind: 'base_plus_commission' | 'commission_only';
    baseSalaryCents: number;
    payPeriod: 'monthly' | 'biweekly';
    commissionRules: unknown[];
    effectiveFrom: string;
    effectiveTo: string | null;
  };
  assignedUsers: Array<{
    userId: string;
    branchId: string;
    branchName: string | null;
    effectiveFrom: string;
    effectiveTo: string | null;
  }>;
}

export default async function CompPlanDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const res = await apiServerFetch<CompPlanDetail>(
    `/api/v1/corporate/comp-plans/${id}`,
  );
  if (res.status === 404 || !res.body.ok || !res.body.data) {
    notFound();
  }
  const { plan, assignedUsers } = res.body.data;

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">{plan.name}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {plan.kind} · {plan.payPeriod}
        </p>
      </header>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-medium text-slate-900 uppercase tracking-wide mb-3">
          Edit
        </h2>
        <CompPlanForm mode="edit" initial={plan} />
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-medium text-slate-900 uppercase tracking-wide mb-3">
          Currently assigned ({assignedUsers.length})
        </h2>
        {assignedUsers.length === 0 ? (
          <p className="text-sm text-slate-500">No active assignments.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {assignedUsers.map((a) => (
              <li
                key={`${a.userId}-${a.branchId}`}
                className="py-2 flex items-center justify-between"
              >
                <div>
                  <div className="text-slate-800 font-mono text-xs">
                    {a.userId}
                  </div>
                  <div className="text-xs text-slate-500">
                    {a.branchName ?? a.branchId}
                  </div>
                </div>
                <div className="text-xs text-slate-500">
                  Since {new Date(a.effectiveFrom).toLocaleDateString()}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
