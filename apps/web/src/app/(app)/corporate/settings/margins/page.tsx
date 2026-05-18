import { apiServerFetch } from '../../../../../lib/api.js';
import { MarginSettings, type MarginsData } from './MarginSettings';

/**
 * Corporate margin policy editor (SQB-08).
 *
 * Reads the current default + min + max + category overrides from
 * `GET /api/v1/corporate/margins` server-side, hands the data to a
 * client component that lets corporate_admin edit policy + overrides
 * via PATCH / POST / DELETE on the same surface. The corporate layout
 * already 404s anyone whose scope.type !== 'corporate'.
 */
export default async function MarginSettingsPage() {
  const res = await apiServerFetch<MarginsData>('/api/v1/corporate/margins');
  const initial: MarginsData =
    res.body.ok && res.body.data
      ? res.body.data
      : { defaultPct: 0, minPct: 0, maxPct: 0, overrides: [] };

  return (
    <section>
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Margin policy</h1>
        <p className="mt-1 text-sm text-slate-500">
          Default selling-price margin, optional category overrides, and the
          allowed corporate-wide bounds.
        </p>
      </div>
      <div className="mt-6">
        <MarginSettings initial={initial} />
      </div>
    </section>
  );
}
