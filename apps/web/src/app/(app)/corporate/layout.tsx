import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { requireSession } from '../../../lib/session.js';

/**
 * Server-side guard for /corporate/*. The outer (app)/layout.tsx already
 * wraps every child in AppShell, so this layout only enforces the scope
 * gate: anyone not on a corporate scope sees a 404 (same cross-tenant
 * pattern as the API).
 */
export default async function CorporateLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await requireSession('/corporate');
  if (session.scope?.type !== 'corporate') {
    notFound();
  }
  return <>{children}</>;
}
