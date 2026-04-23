/**
 * TASK-TEN-06 structural tests for the auth UI.
 *
 * Filesystem-only — no React runtime — so these run fast and fail
 * immediately if a required route file goes missing. Behavioural
 * verification (form submits hit the right endpoint, accept-invite
 * flow creates a membership, sign-out invalidates) lives at the API
 * layer under apps/api/src/__tests__/live-*.test.ts which exercises
 * the same endpoints this UI calls.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB_ROOT = join(__dirname, '..', '..');

function read(relPath: string): string {
  return readFileSync(join(WEB_ROOT, relPath), 'utf8');
}
function exists(relPath: string): boolean {
  return existsSync(join(WEB_ROOT, relPath));
}

describe('TEN-06 / auth route files exist', () => {
  it.each([
    'src/app/(auth)/layout.tsx',
    'src/app/(auth)/signin/page.tsx',
    'src/app/(auth)/signin/SignInForm.tsx',
    'src/app/(auth)/signup/page.tsx',
    'src/app/(auth)/signup/SignUpForm.tsx',
    'src/app/(auth)/verify/page.tsx',
    'src/app/(auth)/accept-invite/[token]/page.tsx',
    'src/app/(auth)/accept-invite/[token]/AcceptInviteForm.tsx',
    'src/app/(app)/layout.tsx',
    'src/app/(app)/AppShell.tsx',
    'src/app/(app)/dashboard/page.tsx',
    'src/lib/api.ts',
    'src/lib/session.ts',
  ])('%s is present', (rel) => {
    expect(exists(rel)).toBe(true);
  });
});

describe('TEN-06 / api + session lib shape', () => {
  it('api.ts exports apiServerFetch and apiClientFetch', () => {
    const src = read('src/lib/api.ts');
    expect(src).toMatch(/export async function apiServerFetch/);
    expect(src).toMatch(/export async function apiClientFetch/);
  });

  it('apiServerFetch forwards cookies from next/headers', () => {
    const src = read('src/lib/api.ts');
    expect(src).toMatch(/next\/headers/);
    expect(src).toMatch(/\.getAll\(\)/);
  });

  it('apiClientFetch uses credentials: include', () => {
    const src = read('src/lib/api.ts');
    expect(src).toMatch(/credentials:\s*'include'/);
  });

  it('session.ts exports getSession and requireSession', () => {
    const src = read('src/lib/session.ts');
    expect(src).toMatch(/export async function getSession/);
    expect(src).toMatch(/export async function requireSession/);
  });

  it('requireSession redirects to /signin with ?next= when no session', () => {
    const src = read('src/lib/session.ts');
    expect(src).toMatch(/redirect\(`\/signin\?next=/);
  });
});

describe('TEN-06 / signin and signup forms hit the right endpoints', () => {
  it('SignInForm POSTs to /api/auth/sign-in/email', () => {
    const src = read('src/app/(auth)/signin/SignInForm.tsx');
    expect(src).toMatch(/\/api\/auth\/sign-in\/email/);
    expect(src).toMatch(/method:\s*'POST'/);
  });

  it('SignUpForm POSTs to /api/auth/sign-up/email', () => {
    const src = read('src/app/(auth)/signup/SignUpForm.tsx');
    expect(src).toMatch(/\/api\/auth\/sign-up\/email/);
  });

  it('Both forms are wrapped in Suspense from server page.tsx', () => {
    const signinPage = read('src/app/(auth)/signin/page.tsx');
    const signupPage = read('src/app/(auth)/signup/page.tsx');
    expect(signinPage).toMatch(/from 'react'/);
    expect(signinPage).toMatch(/Suspense/);
    expect(signupPage).toMatch(/Suspense/);
  });
});

describe('TEN-06 / accept-invite page routes by session state', () => {
  const src = read('src/app/(auth)/accept-invite/[token]/page.tsx');

  it('fetches invite metadata from /api/v1/invites/accept/:token', () => {
    expect(src).toMatch(/\/api\/v1\/invites\/accept\//);
  });

  it('renders a friendly error for expired / revoked / used tokens', () => {
    expect(src).toMatch(/INVITE_EXPIRED/);
    expect(src).toMatch(/INVITE_REVOKED/);
    expect(src).toMatch(/INVITE_USED/);
  });

  it('offers sign-in and sign-up routes with email+next prefilled', () => {
    expect(src).toMatch(/\/signin\?email=/);
    expect(src).toMatch(/\/signup\?email=/);
    expect(src).toMatch(/next=/);
  });
});

describe('TEN-06 / accept-invite client form POSTs to accept endpoint', () => {
  const src = read('src/app/(auth)/accept-invite/[token]/AcceptInviteForm.tsx');

  it('POSTs to /api/v1/invites/accept/:token', () => {
    expect(src).toMatch(/\/api\/v1\/invites\/accept\//);
    expect(src).toMatch(/method:\s*'POST'/);
  });

  it('surfaces EMAIL_MISMATCH explicitly', () => {
    expect(src).toMatch(/EMAIL_MISMATCH/);
  });

  it('redirects to /dashboard on success', () => {
    expect(src).toMatch(/router\.push\(['"]\/dashboard['"]/);
  });
});

describe('TEN-06 / protected (app) layout guards with requireSession', () => {
  it('layout calls requireSession', () => {
    const src = read('src/app/(app)/layout.tsx');
    expect(src).toMatch(/requireSession/);
  });

  it('AppShell posts to /api/auth/sign-out on sign-out', () => {
    const src = read('src/app/(app)/AppShell.tsx');
    expect(src).toMatch(/\/api\/auth\/sign-out/);
    expect(src).toMatch(/method:\s*'POST'/);
  });

  it('AppShell displays a scope-describing label', () => {
    const src = read('src/app/(app)/AppShell.tsx');
    expect(src).toMatch(/scope-pill/);
    expect(src).toMatch(/describeScope/);
  });

  it('dashboard page renders the scope payload for debugging', () => {
    const src = read('src/app/(app)/dashboard/page.tsx');
    expect(src).toMatch(/scope-payload/);
    expect(src).toMatch(/getSession/);
  });
});

describe('TEN-06 / next.config rewrites /api/* to the API', () => {
  const src = read('next.config.ts');
  it('defines an async rewrites() function', () => {
    expect(src).toMatch(/async rewrites\(\)/);
  });
  it('routes /api/auth, /api/v1, and /healthz to the API origin', () => {
    expect(src).toMatch(/\/api\/auth\/:path/);
    expect(src).toMatch(/\/api\/v1\/:path/);
    expect(src).toMatch(/\/healthz/);
  });
});
