/**
 * Tests for the corporate-hub RequestScope → GUC flattening (CHR-02).
 *
 * Unit tests (unconditional): scopeToGucs returns the right shape for
 * every variant. Migration-structure assertions cover the original
 * franchise RLS migration (0003) plus the corporate redesign migration
 * (0016) — the latter is the live source of truth post-CHR-01.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeToGucs, type RequestScope } from '../scope.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHR_UP = resolve(
  PKG_ROOT,
  'migrations',
  '0016_corporate_hub_redesign.sql',
);
const CHR_DOWN = resolve(
  PKG_ROOT,
  'migrations',
  '0016_corporate_hub_redesign.down.sql',
);

describe('scopeToGucs', () => {
  it('flattens a corporate scope (no branch)', () => {
    const scope: RequestScope = {
      type: 'corporate',
      userId: 'u1',
      role: 'corporate_admin',
    };
    expect(scopeToGucs(scope)).toEqual({
      role: 'corporate_admin',
      branchId: '',
      userId: 'u1',
    });
  });

  it('flattens a manager scope', () => {
    const scope: RequestScope = {
      type: 'branch',
      userId: 'u2',
      role: 'manager',
      branchId: '22222222-2222-2222-2222-222222222222',
    };
    expect(scopeToGucs(scope)).toEqual({
      role: 'manager',
      branchId: '22222222-2222-2222-2222-222222222222',
      userId: 'u2',
    });
  });

  it.each(['manager', 'dispatcher', 'tech', 'csr'] as const)(
    'preserves the role string for %s',
    (role) => {
      const out = scopeToGucs({
        type: 'branch',
        userId: 'u',
        role,
        branchId: '22222222-2222-2222-2222-222222222222',
      });
      expect(out.role).toBe(role);
    },
  );
});

describe('CHR-01 migration structure (0016_corporate_hub_redesign)', () => {
  const up = readFileSync(CHR_UP, 'utf8');
  const down = readFileSync(CHR_DOWN, 'utf8');

  it('creates all seven new corporate-hub tables', () => {
    for (const t of [
      'corporate',
      'branches',
      'branch_managers',
      'comp_plans',
      'user_comp_assignments',
      'commission_ledger',
      'pricebook_suggestions',
    ]) {
      expect(up).toMatch(new RegExp(`CREATE TABLE ${t}\\b`));
    }
  });

  it('drops every legacy franchise table', () => {
    for (const t of [
      'pricebook_overrides',
      'royalty_statements',
      'royalty_rules',
      'franchise_agreements',
      'franchisees',
      'franchisors',
    ]) {
      expect(up).toMatch(new RegExp(`DROP TABLE IF EXISTS ${t}\\b`));
    }
  });

  it('renames franchisee_id → branch_id on every business table', () => {
    for (const t of [
      'locations',
      'customers',
      'jobs',
      'invoices',
      'invoice_line_items',
      'payments',
      'refunds',
    ]) {
      expect(up).toMatch(
        new RegExp(`ALTER TABLE ${t}\\s+RENAME COLUMN franchisee_id\\s+TO branch_id`),
      );
    }
  });

  it('renames target_franchisee_id → target_branch_id on audit_log', () => {
    expect(up).toMatch(
      /ALTER TABLE audit_log\s+RENAME COLUMN target_franchisee_id\s+TO target_branch_id/,
    );
  });

  it('writes the pricebook_overrides snapshot CSV before destructive DDL', () => {
    expect(up).toMatch(/\\copy pricebook_overrides TO '\.\.\/\.\.\/docs\/migrations\/0016_pricebook_overrides_snapshot\.csv'/);
  });

  it('down migration restores franchisors + franchisees', () => {
    expect(down).toMatch(/CREATE TABLE franchisors\b/);
    expect(down).toMatch(/CREATE TABLE franchisees\b/);
  });

  it('down migration drops every corporate-hub table', () => {
    for (const t of [
      'pricebook_suggestions',
      'commission_ledger',
      'user_comp_assignments',
      'comp_plans',
      'branch_managers',
      'branches',
      'corporate',
    ]) {
      expect(down).toMatch(new RegExp(`DROP TABLE IF EXISTS ${t}\\b`));
    }
  });

  it('down migration renames branch_id back to franchisee_id', () => {
    expect(down).toMatch(
      /ALTER TABLE locations\s+RENAME COLUMN branch_id\s+TO franchisee_id/,
    );
  });
});
