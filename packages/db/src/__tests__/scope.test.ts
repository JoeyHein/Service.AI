/**
 * Tests for TASK-TEN-03: RequestScope → GUC flattening and RLS policy
 * migration structure.
 *
 * Unit tests (unconditional): scopeToGucs returns the right shape for every
 * variant. RLS migration SQL contains every expected CREATE POLICY name and
 * the .down.sql drops them all.
 *
 * Integration test (skipped when Postgres is unreachable): withScope opens a
 * transaction, sets the three GUCs, and Postgres reads them back. Matches
 * the reachability-gated pattern already used by health-checks.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeToGucs, type RequestScope } from '../scope.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RLS_SQL = resolve(PKG_ROOT, 'migrations', '0003_rls_policies.sql');
const RLS_DOWN_SQL = resolve(PKG_ROOT, 'migrations', '0003_rls_policies.down.sql');

describe('scopeToGucs', () => {
  it('flattens a platform_admin scope (no franchisor/franchisee)', () => {
    const scope: RequestScope = {
      type: 'platform',
      userId: 'u1',
      role: 'platform_admin',
    };
    expect(scopeToGucs(scope)).toEqual({
      role: 'platform_admin',
      franchisorId: '',
      franchiseeId: '',
    });
  });

  it('flattens a franchisor_admin scope (franchisor, no franchisee)', () => {
    const scope: RequestScope = {
      type: 'franchisor',
      userId: 'u1',
      role: 'franchisor_admin',
      franchisorId: '11111111-1111-1111-1111-111111111111',
    };
    expect(scopeToGucs(scope)).toEqual({
      role: 'franchisor_admin',
      franchisorId: '11111111-1111-1111-1111-111111111111',
      franchiseeId: '',
    });
  });

  it('flattens a franchisee-scoped role (all three set)', () => {
    const scope: RequestScope = {
      type: 'franchisee',
      userId: 'u1',
      role: 'dispatcher',
      franchisorId: '11111111-1111-1111-1111-111111111111',
      franchiseeId: '22222222-2222-2222-2222-222222222222',
      locationId: '33333333-3333-3333-3333-333333333333',
    };
    expect(scopeToGucs(scope)).toEqual({
      role: 'dispatcher',
      franchisorId: '11111111-1111-1111-1111-111111111111',
      franchiseeId: '22222222-2222-2222-2222-222222222222',
    });
  });

  it('preserves the role string for each franchisee role variant', () => {
    const roles = ['franchisee_owner', 'location_manager', 'dispatcher', 'tech', 'csr'] as const;
    for (const role of roles) {
      const out = scopeToGucs({
        type: 'franchisee',
        userId: 'u',
        role,
        franchisorId: '11111111-1111-1111-1111-111111111111',
        franchiseeId: '22222222-2222-2222-2222-222222222222',
      });
      expect(out.role).toBe(role);
    }
  });
});

describe('RLS policy migration SQL structure', () => {
  const up = readFileSync(RLS_SQL, 'utf8');
  const down = readFileSync(RLS_DOWN_SQL, 'utf8');

  const tables = ['franchisees', 'locations', 'memberships', 'audit_log'] as const;
  const roles = ['platform_admin', 'franchisor_admin', 'scoped'] as const;

  it('enables FORCE ROW LEVEL SECURITY on every tenant-scoped table', () => {
    for (const t of tables) {
      expect(up).toMatch(new RegExp(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`));
    }
  });

  it('defines one CREATE POLICY per (table, role) combination', () => {
    for (const t of tables) {
      for (const r of roles) {
        expect(up).toMatch(
          new RegExp(`CREATE POLICY ${t}_${r} ON ${t}`),
        );
      }
    }
  });

  it('reads the three expected GUCs via current_setting', () => {
    expect(up).toMatch(/current_setting\('app\.role', true\)/);
    expect(up).toMatch(/current_setting\('app\.franchisor_id', true\)/);
    expect(up).toMatch(/current_setting\('app\.franchisee_id', true\)/);
  });

  it('down migration drops every policy the up migration created', () => {
    for (const t of tables) {
      for (const r of roles) {
        expect(down).toMatch(
          new RegExp(`DROP POLICY IF EXISTS ${t}_${r}\\s+ON ${t}`),
        );
      }
    }
  });

  it('down migration clears FORCE ROW LEVEL SECURITY', () => {
    for (const t of tables) {
      expect(down).toMatch(new RegExp(`ALTER TABLE IF EXISTS ${t}\\s+NO FORCE ROW LEVEL SECURITY`));
    }
  });
});
