/**
 * TASK-TEN-08 structural tests for the audit log viewer.
 *
 * Filesystem-only. Behavioural round-trips (scope filtering, role-based
 * 403, filter/search/pagination) are covered live against real Postgres
 * in apps/api/src/__tests__/live-audit-log.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB_ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(WEB_ROOT, rel), 'utf8');
const exists = (rel: string) => existsSync(join(WEB_ROOT, rel));

describe('TEN-08 / audit viewer files exist', () => {
  it.each([
    'src/app/(app)/franchisor/audit/page.tsx',
    'src/app/(app)/franchisor/audit/AuditLogTable.tsx',
  ])('%s is present', (rel) => {
    expect(exists(rel)).toBe(true);
  });
});

describe('TEN-08 / audit page access control + filters', () => {
  const src = read('src/app/(app)/franchisor/audit/page.tsx');

  it('guards to platform + franchisor admins via notFound()', () => {
    expect(src).toMatch(/notFound\(\)/);
    expect(src).toMatch(/scope\?\.type !== 'platform'/);
    expect(src).toMatch(/scope\?\.type !== 'franchisor'/);
  });

  it('calls GET /api/v1/audit-log with the composed query string', () => {
    expect(src).toMatch(/\/api\/v1\/audit-log/);
    expect(src).toMatch(/URLSearchParams/);
  });

  it('wires every filter field to the API: actorEmail, action, franchiseeId, fromDate, toDate', () => {
    expect(src).toMatch(/actorEmail/);
    expect(src).toMatch(/\baction\b/);
    expect(src).toMatch(/franchiseeId/);
    expect(src).toMatch(/fromDate/);
    expect(src).toMatch(/toDate/);
  });

  it('renders the filter form as a GET-method form (URL state, reloadable)', () => {
    expect(src).toMatch(/method="get"/);
  });
});

describe('TEN-08 / AuditLogTable renders rows + pagination', () => {
  const src = read('src/app/(app)/franchisor/audit/AuditLogTable.tsx');

  it('has a data-testid the security suite can scrape', () => {
    expect(src).toMatch(/data-testid="audit-log-table"/);
  });

  it('shows actor email / action / target franchisee / metadata columns', () => {
    expect(src).toMatch(/Time/);
    expect(src).toMatch(/Actor/);
    expect(src).toMatch(/Action/);
    expect(src).toMatch(/Target franchisee/);
    expect(src).toMatch(/Metadata/);
  });

  it('exposes Previous / Next pagination links preserving filters', () => {
    expect(src).toMatch(/Previous/);
    expect(src).toMatch(/Next/);
    expect(src).toMatch(/pageLink/);
  });

  it('renders an empty state when rows.length === 0', () => {
    expect(src).toMatch(/No entries to show/);
  });
});

describe('TEN-08 / AppShell nav includes Audit log link for platform + franchisor', () => {
  const src = read('src/app/(app)/AppShell.tsx');
  it('renders an Audit log link for platform OR franchisor scopes', () => {
    expect(src).toMatch(/\/franchisor\/audit/);
    expect(src).toMatch(/isPlatformOrFranchisor/);
  });
  it('hides the audit link while impersonating', () => {
    // The isPlatformOrFranchisor guard explicitly excludes
    // session.impersonating so HQ users stay in impersonated context.
    expect(src).toMatch(/!session\.impersonating/);
  });
});
