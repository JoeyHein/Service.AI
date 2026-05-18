import Link from 'next/link';
import { apiServerFetch } from '../../../../lib/api.js';

interface CompPlanRow {
  id: string;
  name: string;
  kind: string;
  baseSalaryCents: number;
  payPeriod: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

export default async function CompPlansPage() {
  const res = await apiServerFetch<CompPlanRow[]>(
    '/api/v1/corporate/comp-plans',
  );
  const rows = res.body.ok && res.body.data ? res.body.data : [];

  return (
    <section>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Comp plans</h1>
          <p className="mt-1 text-sm text-slate-500">
            {rows.length === 0
              ? 'No plans yet.'
              : `${rows.length} plan${rows.length === 1 ? '' : 's'} on file.`}
          </p>
        </div>
        <Link
          href="/corporate/comp-plans/new"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          New plan
        </Link>
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full text-sm divide-y divide-slate-200">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Kind</th>
              <th className="px-3 py-2 font-medium">Pay period</th>
              <th className="px-3 py-2 font-medium text-right">Base salary</th>
              <th className="px-3 py-2 font-medium">Effective</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                  No comp plans yet.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2">
                    <Link
                      href={`/corporate/comp-plans/${r.id}`}
                      className="font-medium text-blue-700 hover:underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-slate-700">{r.kind}</td>
                  <td className="px-3 py-2 text-slate-700">{r.payPeriod}</td>
                  <td className="px-3 py-2 text-right">
                    {money(r.baseSalaryCents)}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {new Date(r.effectiveFrom).toLocaleDateString()} —{' '}
                    {r.effectiveTo
                      ? new Date(r.effectiveTo).toLocaleDateString()
                      : 'ongoing'}
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
