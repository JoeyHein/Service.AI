import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { requireSession } from '../../lib/session.js';
import { TechShell } from './TechShell';

/**
 * Protected layout for the tech mobile PWA. Narrower-than-office chrome
 * because this view is optimised for a phone screen.
 *
 * Access rule (phase_tech_mobile_pwa gate): only callers whose active
 * scope is a tech membership may see /tech/* routes. Any other role
 * — including franchisee owner, dispatcher, CSR, franchisor admin,
 * platform admin — gets notFound() so the URL doesn't leak the
 * existence of a tech-only area.
 */
export default async function TechLayout({ children }: { children: ReactNode }) {
  const session = await requireSession('/tech');
  if (session.scope?.type !== 'franchisee' || session.scope.role !== 'tech') {
    notFound();
  }
  return <TechShell session={session}>{children}</TechShell>;
}
