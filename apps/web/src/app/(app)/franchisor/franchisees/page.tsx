import { notFound } from 'next/navigation';
import { apiServerFetch } from '../../../../lib/api.js';
import { getSession } from '../../../../lib/session.js';
import { FranchiseesList } from './FranchiseesList';

interface FranchiseeRow {
  id: string;
  name: string;
  slug: string;
  franchisorId: string;
}

/**
 * Franchisor-admin only. Lists every franchisee under the caller's
 * franchisor and offers a "View as" button per row. Clicking it POSTs
 * /impersonate/start — the server cookie is set, the next /me returns
 * the narrowed scope, and the HQ banner renders automatically.
 *
 * Access control: scope.type !== 'franchisor' → notFound() (404) so
 * we don't leak the existence of the route to unauthorized users.
 * Platform admins also don't see it — they get a dedicated console
 * surface in later phases.
 */
export default async function FranchiseesPage() {
  const session = await getSession();
  if (!session || session.scope?.type !== 'franchisor') {
    notFound();
  }

  const res = await apiServerFetch<FranchiseeRow[]>('/api/v1/franchisees');
  const rows = res.body.ok && res.body.data ? res.body.data : [];

  return (
    <section>
      <h1 className="text-2xl font-semibold text-slate-900">Franchisees</h1>
      <p className="mt-1 text-sm text-slate-500">
        {rows.length === 0
          ? 'No franchisees yet.'
          : `${rows.length} franchisee${rows.length === 1 ? '' : 's'} in your network.`}
      </p>
      <FranchiseesList rows={rows} />
    </section>
  );
}
