/**
 * Server-side session helpers. Use only in Server Components, Route
 * Handlers, or Server Actions — these call next/headers and will throw
 * if invoked on the client.
 */
import { redirect } from 'next/navigation';
import { apiServerFetch } from './api.js';

export interface MeScope {
  type: 'platform' | 'franchisor' | 'franchisee';
  userId: string;
  role: string;
  franchisorId?: string;
  franchiseeId?: string;
  locationId?: string | null;
}

export interface MeResponse {
  user: { id: string };
  scope: MeScope | null;
}

/**
 * Returns the authenticated session's user + resolved scope, or null when
 * the caller is anonymous. Never throws on missing auth.
 */
export async function getSession(): Promise<MeResponse | null> {
  const res = await apiServerFetch<MeResponse>('/api/v1/me');
  if (res.status !== 200 || !res.body.ok || !res.body.data) return null;
  return res.body.data;
}

/**
 * Guard helper for protected pages. Redirects to /signin?next=<url> when
 * no valid session exists.
 */
export async function requireSession(currentPath: string): Promise<MeResponse> {
  const session = await getSession();
  if (!session) {
    const next = encodeURIComponent(currentPath);
    redirect(`/signin?next=${next}`);
  }
  return session;
}
