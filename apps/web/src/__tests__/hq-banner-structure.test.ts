/**
 * TASK-TEN-07 structural tests for the HQ impersonation UI.
 *
 * Same filesystem-only pattern as the other web structural suites.
 * Behavioural round-trips (franchisor_admin → cookie → narrowed scope
 * → audit row) are already live-tested at the API layer in
 * apps/api/src/__tests__/impersonation.test.ts and live-security.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB_ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(WEB_ROOT, rel), 'utf8');
const exists = (rel: string) => existsSync(join(WEB_ROOT, rel));

describe('TEN-07 / impersonation route files exist', () => {
  it.each([
    'src/app/impersonate/start/route.ts',
    'src/app/impersonate/stop/route.ts',
    'src/app/(app)/HqBanner.tsx',
    'src/app/(app)/franchisor/franchisees/page.tsx',
    'src/app/(app)/franchisor/franchisees/FranchiseesList.tsx',
  ])('%s is present', (rel) => {
    expect(exists(rel)).toBe(true);
  });
});

describe('TEN-07 / /impersonate/start route handler', () => {
  const src = read('src/app/impersonate/start/route.ts');

  it('sets the serviceai.impersonate cookie', () => {
    expect(src).toMatch(/cookieStore\.set\(['"]serviceai\.impersonate['"]/);
  });

  it('uses httpOnly + sameSite=lax + path=/', () => {
    expect(src).toMatch(/httpOnly:\s*true/);
    expect(src).toMatch(/sameSite:\s*['"]lax['"]/);
    expect(src).toMatch(/path:\s*['"]\/['"]/);
  });

  it('rejects non-UUID franchisee ids with 400 INVALID_TARGET', () => {
    expect(src).toMatch(/INVALID_TARGET/);
    expect(src).toMatch(/status:\s*400/);
  });

  it('secures the cookie in production', () => {
    expect(src).toMatch(/NODE_ENV.+production/);
  });
});

describe('TEN-07 / /impersonate/stop route handler', () => {
  const src = read('src/app/impersonate/stop/route.ts');

  it('deletes the serviceai.impersonate cookie', () => {
    expect(src).toMatch(/cookieStore\.delete\(['"]serviceai\.impersonate['"]\)/);
  });
});

describe('TEN-07 / HqBanner client component', () => {
  const src = read('src/app/(app)/HqBanner.tsx');

  it('is a client component', () => {
    expect(src).toMatch(/^'use client';/);
  });

  it('renders a red banner labelled "HQ VIEWING"', () => {
    expect(src).toMatch(/bg-red-600/);
    expect(src).toMatch(/HQ VIEWING:/);
  });

  it('posts to /impersonate/stop on return-to-network click', () => {
    expect(src).toMatch(/\/impersonate\/stop/);
    expect(src).toMatch(/method:\s*['"]POST['"]/);
  });

  it('has a testid so the security suite can assert presence', () => {
    expect(src).toMatch(/data-testid=['"]hq-banner['"]/);
  });
});

describe('TEN-07 / AppShell integrates HqBanner + franchisor nav', () => {
  const src = read('src/app/(app)/AppShell.tsx');

  it('imports HqBanner', () => {
    expect(src).toMatch(/import \{ HqBanner \}/);
  });

  it('renders HqBanner when session.impersonating is non-null', () => {
    expect(src).toMatch(/session\.impersonating/);
    expect(src).toMatch(/<HqBanner/);
  });

  it('shows a Franchisees nav link to franchisor admins not currently impersonating', () => {
    expect(src).toMatch(/\/franchisor\/franchisees/);
    // Hidden when impersonating so HQ users stay in the impersonated context.
    expect(src).toMatch(/!session\.impersonating/);
  });
});

describe('TEN-07 / franchisees page + list', () => {
  const page = read('src/app/(app)/franchisor/franchisees/page.tsx');
  const list = read('src/app/(app)/franchisor/franchisees/FranchiseesList.tsx');

  it('page guards access to franchisor scope only (notFound otherwise)', () => {
    expect(page).toMatch(/notFound\(\)/);
    expect(page).toMatch(/scope\?\.type !== 'franchisor'/);
  });

  it('page calls GET /api/v1/franchisees', () => {
    expect(page).toMatch(/\/api\/v1\/franchisees/);
  });

  it('list POSTs to /impersonate/start on "View as"', () => {
    expect(list).toMatch(/\/impersonate\/start/);
    expect(list).toMatch(/method:\s*['"]POST['"]/);
  });

  it('list redirects to /dashboard after starting impersonation', () => {
    expect(list).toMatch(/router\.push\(['"]\/dashboard['"]\)/);
  });

  it('list renders a view-as-<slug> testid per row for scraping', () => {
    expect(list).toMatch(/view-as-\$\{row\.slug\}/);
  });
});

describe('TEN-07 / MeResponse gains impersonating field', () => {
  const src = read('src/lib/session.ts');
  it('exports ImpersonatingContext', () => {
    expect(src).toMatch(/ImpersonatingContext/);
  });
  it('MeResponse includes an impersonating field (non-null when active)', () => {
    expect(src).toMatch(/impersonating:\s*ImpersonatingContext \| null/);
  });
});
