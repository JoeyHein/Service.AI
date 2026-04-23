import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * Start impersonating a franchisee. Called from the "View as" button on
 * the /franchisor/franchisees page. Sets the `serviceai.impersonate`
 * cookie which the API's requestScopePlugin picks up on every
 * subsequent request — no header injection needed from the browser.
 *
 * The API validates on first use (franchisor_admin required, target
 * must belong to the acting franchisor). We do a light UUID-shape
 * check here so a bad payload never touches the API; anything that
 * passes this check either becomes a valid impersonation or a 403 on
 * the next /api/v1/me call.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { franchiseeId?: string };
  const id = body.franchiseeId ?? '';
  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_TARGET', message: 'franchiseeId must be a UUID' } },
      { status: 400 },
    );
  }

  const cookieStore = await cookies();
  cookieStore.set('serviceai.impersonate', id, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  });
  return NextResponse.json({ ok: true, data: { franchiseeId: id } });
}
