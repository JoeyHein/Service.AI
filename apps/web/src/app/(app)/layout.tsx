import type { ReactNode } from 'react';
import { requireSession } from '../../lib/session.js';
import { AppShell } from './AppShell';

/**
 * Layout for every protected route under /(app). Server-side fetches the
 * session via /api/v1/me; a 401 triggers a redirect to /signin?next=<url>
 * from requireSession(). The resolved session is passed down into the
 * client-side AppShell so nav + sign-out work without a second fetch.
 *
 * Next.js 15 doesn't expose the current request path to a layout via a
 * hook-like API in server components, so we pass `/dashboard` as a
 * reasonable default — the client-side router replaces the URL correctly
 * after redirect.
 */
export default async function ProtectedLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await requireSession('/dashboard');
  return <AppShell session={session}>{children}</AppShell>;
}
