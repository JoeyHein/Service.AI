import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { requireSession } from '../../../lib/session.js';

/**
 * Server-side guard for /branch/*. Mirrors the /corporate/* layout's
 * scope check: only branch-scoped users (manager / dispatcher / tech /
 * csr) see this surface. Corporate admins get notFound() — they use
 * /corporate/branches/:id for branch oversight, not /branch.
 *
 * The dashboard route inside narrows further to manager-only because
 * tiles surface commission data CSR/tech/dispatcher shouldn't see;
 * non-manager branch users land on the dashboard URL and get the API's
 * 404. Acceptable for v1 — a friendlier in-page redirect can land with
 * the per-role branch-side UX later.
 */
export default async function BranchLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await requireSession('/branch');
  if (session.scope?.type !== 'branch') {
    notFound();
  }
  return <>{children}</>;
}
