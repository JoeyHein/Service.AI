import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * Stop impersonating. Called from the HQ banner's "Return to network
 * view" button. Clears the `serviceai.impersonate` cookie so the next
 * /me call returns the franchisor_admin's native scope.
 */
export async function POST() {
  const cookieStore = await cookies();
  cookieStore.delete('serviceai.impersonate');
  return NextResponse.json({ ok: true });
}
