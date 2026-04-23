import { getSession } from '../../../lib/session.js';

/**
 * Placeholder scoped dashboard. Phase_tenancy_franchise's UI gate is to
 * prove that an authenticated user lands somewhere that reflects their
 * scope — customer / job / dispatch surfaces come in phase_customer_job
 * and phase_dispatch. For now we render the raw scope payload so the
 * accept-invite → dashboard redirect is visually verifiable.
 */
export default async function DashboardPage() {
  const session = await getSession();
  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
      <p className="mt-1 text-sm text-slate-500">
        Scope details below. Real dashboard surfaces land in later phases.
      </p>

      <div className="mt-6 bg-white rounded-lg border border-slate-200 p-6">
        <h2 className="text-sm font-medium text-slate-900 uppercase tracking-wide">
          Your scope
        </h2>
        <pre
          data-testid="scope-payload"
          className="mt-3 text-xs text-slate-700 bg-slate-50 rounded p-3 overflow-x-auto"
        >
          {JSON.stringify(session?.scope ?? null, null, 2)}
        </pre>
      </div>
    </section>
  );
}
