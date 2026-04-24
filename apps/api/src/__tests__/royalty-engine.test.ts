/**
 * Unit tests for the pure royalty rule engine (TASK-RE-02).
 *
 * The engine is pure, so every test case is a single function
 * call — no DB, no fixtures, no stubbing. Covers every rule type
 * and the combinatorics the gate calls out.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveFeeCents,
  defaultFallbackFeeCents,
  type StoredRule,
  type ResolveContext,
} from '../royalty-engine.js';

const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
  totalCents: 100000,
  jobCountThisMonth: 0,
  monthGrossCents: 0,
  monthFeesAccruedCents: 0,
  ...over,
});

const rule = (
  ruleType: StoredRule['ruleType'],
  params: unknown,
  sortOrder = 0,
): StoredRule => ({ ruleType, params, sortOrder });

describe('RE-02 / percentage rule', () => {
  it('8% of $1000 = $80 (8000 cents)', () => {
    const rules = [rule('percentage', { basisPoints: 800 })];
    expect(resolveFeeCents(rules, ctx({ totalCents: 100000 }))).toBe(8000);
  });

  it('zero total → zero fee regardless of rule', () => {
    const rules = [rule('percentage', { basisPoints: 1000 })];
    expect(resolveFeeCents(rules, ctx({ totalCents: 0 }))).toBe(0);
  });

  it('percentage on $10 rounds to cents (10% of 1000 = 100)', () => {
    const rules = [rule('percentage', { basisPoints: 1000 })];
    expect(resolveFeeCents(rules, ctx({ totalCents: 1000 }))).toBe(100);
  });

  it('odd-cent rounding: 3.3% of $99.99 → round-half-away-from-zero', () => {
    const rules = [rule('percentage', { basisPoints: 330 })];
    // 9999 * 330 / 10000 = 329.967 → 330
    expect(resolveFeeCents(rules, ctx({ totalCents: 9999 }))).toBe(330);
  });
});

describe('RE-02 / flat_per_job rule', () => {
  it('adds a flat amount per invoice', () => {
    const rules = [rule('flat_per_job', { amountCents: 2500 })];
    expect(resolveFeeCents(rules, ctx({ totalCents: 100000 }))).toBe(2500);
  });

  it('can stack with a percentage rule', () => {
    const rules = [
      rule('percentage', { basisPoints: 500 }, 0),
      rule('flat_per_job', { amountCents: 1000 }, 1),
    ];
    // 5% of 100000 = 5000; + 1000 = 6000
    expect(resolveFeeCents(rules, ctx({ totalCents: 100000 }))).toBe(6000);
  });
});

describe('RE-02 / tiered rule', () => {
  const tieredRule = rule('tiered', {
    tiers: [
      { upToCents: 1000000, basisPoints: 1000 }, // 10% on first $10k
      { upToCents: 5000000, basisPoints: 800 }, // 8% $10k–$50k
      { upToCents: null, basisPoints: 500 }, // 5% above $50k
    ],
  });

  it('first tier only when gross is below ceiling', () => {
    // Month gross starts at 0, invoice 5000 cents → tier-1 fully.
    expect(resolveFeeCents([tieredRule], ctx({ totalCents: 5000 }))).toBe(500);
  });

  it('crosses into second tier partway', () => {
    // Month gross 900000 cents, invoice 200000 cents →
    // 100000 at 10% + 100000 at 8% = 10000 + 8000 = 18000
    expect(
      resolveFeeCents(
        [tieredRule],
        ctx({ totalCents: 200000, monthGrossCents: 900000 }),
      ),
    ).toBe(18000);
  });

  it('starts already in second tier', () => {
    // Gross 2000000 → this invoice fully inside tier 2.
    expect(
      resolveFeeCents(
        [tieredRule],
        ctx({ totalCents: 100000, monthGrossCents: 2000000 }),
      ),
    ).toBe(8000);
  });

  it('last tier (null upper bound) absorbs everything remaining', () => {
    // Gross 6000000 → this invoice is fully in tier 3 at 5%.
    expect(
      resolveFeeCents(
        [tieredRule],
        ctx({ totalCents: 100000, monthGrossCents: 6000000 }),
      ),
    ).toBe(5000);
  });
});

describe('RE-02 / minimum_floor rule', () => {
  it('bumps accrued fees up to the monthly floor', () => {
    // 10% of 1000 = 100; but floor is $500 and nothing accrued yet →
    // bump to 500 (but clamped to total of 1000).
    const rules = [
      rule('percentage', { basisPoints: 1000 }, 0),
      rule('minimum_floor', { perMonthCents: 50000 }, 1),
    ];
    expect(resolveFeeCents(rules, ctx({ totalCents: 1000 }))).toBe(1000);
  });

  it('does nothing once accrued + current fee already clears the floor', () => {
    const rules = [
      rule('percentage', { basisPoints: 500 }, 0),
      rule('minimum_floor', { perMonthCents: 50000 }, 1),
    ];
    // 5% of 100000 = 5000; accrued already 50000 → floor met, no bump
    expect(
      resolveFeeCents(
        rules,
        ctx({ totalCents: 100000, monthFeesAccruedCents: 50000 }),
      ),
    ).toBe(5000);
  });

  it('caps the bump to the invoice total', () => {
    const rules = [
      rule('percentage', { basisPoints: 1 }, 0),
      rule('minimum_floor', { perMonthCents: 1_000_000 }, 1),
    ];
    // total is 1000 cents, floor asks for 1,000,000 — clamp to 1000.
    expect(resolveFeeCents(rules, ctx({ totalCents: 1000 }))).toBe(1000);
  });

  it('respects ordering: floor before percentage does nothing unexpected', () => {
    const rules = [
      rule('minimum_floor', { perMonthCents: 20000 }, 0),
      rule('percentage', { basisPoints: 500 }, 1),
    ];
    // total 100000, floor first: fee=20000 (from 0 to 20000);
    // then 5% of 100000 = 5000; total = 25000.
    expect(resolveFeeCents(rules, ctx({ totalCents: 100000 }))).toBe(25000);
  });
});

describe('RE-02 / combinations', () => {
  it('percentage + flat + floor composes correctly', () => {
    const rules = [
      rule('percentage', { basisPoints: 800 }, 0), // 8%
      rule('flat_per_job', { amountCents: 500 }, 1), // + $5
      rule('minimum_floor', { perMonthCents: 10000 }, 2), // floor $100
    ];
    // Invoice 50000 cents
    // 8% = 4000; + 500 = 4500; floor 10000, accrued 0 → bump to 10000
    expect(resolveFeeCents(rules, ctx({ totalCents: 50000 }))).toBe(10000);
  });

  it('invalid params throw (defensive boundary check)', () => {
    const rules = [rule('percentage', { notBasisPoints: 500 })];
    expect(() => resolveFeeCents(rules, ctx())).toThrow(/basisPoints/);
  });

  it('empty rules array → zero fee', () => {
    expect(resolveFeeCents([], ctx())).toBe(0);
  });
});

describe('RE-02 / defaultFallbackFeeCents', () => {
  it('matches phase 7 behaviour (5%)', () => {
    expect(defaultFallbackFeeCents(100000)).toBe(5000);
  });

  it('rounds correctly on odd cents', () => {
    expect(defaultFallbackFeeCents(9999)).toBe(500);
  });
});
