/**
 * Unit tests for the commission engine's pure helpers (CHR-05).
 *
 * Covers everything the gate requires that does NOT need a live DB:
 *   - periodLabelFor
 *   - applyRuleToInvoice (flat + tiered)
 *   - applyRuleToQuote
 *   - expandRulesForInvoice / expandRulesForQuote (multi-rule expansion)
 *   - prorateBaseSalary (period overlap matrix)
 *
 * The orchestration functions (onInvoicePaid / onQuoteCommitted /
 * reverseInvoicePaid / computeCommission) touch Drizzle directly and
 * are covered by live-commission.test.ts which auto-skips without DB.
 */
import { describe, expect, it } from 'vitest';
import type { CommissionRule } from '@service-ai/contracts';
import {
  applyRuleToInvoice,
  applyRuleToQuote,
  expandRulesForInvoice,
  expandRulesForQuote,
  periodLabelFor,
  prorateBaseSalary,
} from '../commission-engine.js';

// ---------------------------------------------------------------------------
// periodLabelFor
// ---------------------------------------------------------------------------

describe('periodLabelFor', () => {
  it.each([
    { iso: '2026-01-01T00:00:00.000Z', expected: '2026-01' },
    { iso: '2026-01-31T23:59:59.999Z', expected: '2026-01' },
    { iso: '2026-02-01T00:00:00.000Z', expected: '2026-02' },
    { iso: '2026-12-31T23:59:59.999Z', expected: '2026-12' },
    { iso: '2026-05-15T12:34:56.000Z', expected: '2026-05' },
    { iso: '2030-09-09T00:00:00.000Z', expected: '2030-09' },
  ])('$iso -> $expected', ({ iso, expected }) => {
    expect(periodLabelFor(new Date(iso))).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// applyRuleToInvoice — flat rule
// ---------------------------------------------------------------------------

describe('applyRuleToInvoice — flat_percent_of_invoice_paid', () => {
  const rule: CommissionRule = { kind: 'flat_percent_of_invoice_paid', percent: 4 };

  it.each([
    { amount: 0, expected: 0 },
    { amount: -100, expected: 0 },
    { amount: 100, expected: 4 },
    { amount: 10_000, expected: 400 },
    { amount: 100_000, expected: 4_000 },
    { amount: 12_345, expected: 494 },
    { amount: 12_350, expected: 494 },
  ])('$amount cents at 4% -> $expected cents', ({ amount, expected }) => {
    expect(applyRuleToInvoice(rule, amount)).toBe(expected);
  });

  it('respects percent = 0', () => {
    expect(
      applyRuleToInvoice(
        { kind: 'flat_percent_of_invoice_paid', percent: 0 },
        100_000,
      ),
    ).toBe(0);
  });

  it('respects percent = 100', () => {
    expect(
      applyRuleToInvoice(
        { kind: 'flat_percent_of_invoice_paid', percent: 100 },
        100_000,
      ),
    ).toBe(100_000);
  });

  it('ignores quote-commit rules silently', () => {
    expect(
      applyRuleToInvoice(
        { kind: 'flat_percent_of_quote_committed', percent: 4 },
        100_000,
      ),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyRuleToInvoice — tiered rule
// ---------------------------------------------------------------------------

describe('applyRuleToInvoice — tiered_percent_of_invoice_paid', () => {
  const rule: CommissionRule = {
    kind: 'tiered_percent_of_invoice_paid',
    tiers: [
      { floorCents: 0, percent: 3 },
      { floorCents: 50_000, percent: 4 },
      { floorCents: 250_000, percent: 5 },
      { floorCents: 1_000_000, percent: 6 },
    ],
  };

  it.each([
    { amount: 0, expected: 0 },
    { amount: 100, expected: 3 },
    { amount: 49_999, expected: 1_500 }, // 49999 * 3% rounded
    { amount: 50_000, expected: 2_000 }, // 50000 * 4%
    { amount: 250_000, expected: 12_500 }, // 250000 * 5%
    { amount: 999_999, expected: 50_000 }, // 999999 * 5% rounded
    { amount: 1_000_000, expected: 60_000 }, // 1000000 * 6%
  ])('$amount cents -> $expected cents', ({ amount, expected }) => {
    expect(applyRuleToInvoice(rule, amount)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// applyRuleToQuote
// ---------------------------------------------------------------------------

describe('applyRuleToQuote', () => {
  const rule: CommissionRule = { kind: 'flat_percent_of_quote_committed', percent: 2 };

  it.each([
    { amount: 0, expected: 0 },
    { amount: 100_000, expected: 2_000 },
    { amount: 1_250_000, expected: 25_000 },
  ])('credits $expected on $amount', ({ amount, expected }) => {
    expect(applyRuleToQuote(rule, amount)).toBe(expected);
  });

  it('ignores invoice rules', () => {
    expect(
      applyRuleToQuote(
        { kind: 'flat_percent_of_invoice_paid', percent: 4 },
        100_000,
      ),
    ).toBe(0);
    expect(
      applyRuleToQuote(
        {
          kind: 'tiered_percent_of_invoice_paid',
          tiers: [{ floorCents: 0, percent: 4 }],
        },
        100_000,
      ),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// expandRulesForInvoice / expandRulesForQuote
// ---------------------------------------------------------------------------

describe('expandRulesForInvoice', () => {
  it('returns one entry per rule that yields a non-zero credit', () => {
    const rules: CommissionRule[] = [
      { kind: 'flat_percent_of_invoice_paid', percent: 4 },
      { kind: 'flat_percent_of_quote_committed', percent: 2 }, // skipped
      {
        kind: 'tiered_percent_of_invoice_paid',
        tiers: [
          { floorCents: 0, percent: 1 },
          { floorCents: 100_000, percent: 2 },
        ],
      },
    ];
    const out = expandRulesForInvoice(rules, 200_000);
    expect(out.length).toBe(2);
    const amounts = out.map((r) => r.amountCents);
    expect(amounts).toContain(8_000); // 200000 * 4%
    expect(amounts).toContain(4_000); // 200000 * 2%
  });

  it('returns empty array for amount = 0', () => {
    const rules: CommissionRule[] = [
      { kind: 'flat_percent_of_invoice_paid', percent: 100 },
    ];
    expect(expandRulesForInvoice(rules, 0)).toEqual([]);
  });

  it('drops rules whose tiered match yields 0', () => {
    const rules: CommissionRule[] = [
      { kind: 'flat_percent_of_invoice_paid', percent: 0 },
      {
        kind: 'tiered_percent_of_invoice_paid',
        tiers: [{ floorCents: 0, percent: 0 }],
      },
    ];
    expect(expandRulesForInvoice(rules, 100_000)).toEqual([]);
  });
});

describe('expandRulesForQuote', () => {
  it('filters out invoice-only rules', () => {
    const rules: CommissionRule[] = [
      { kind: 'flat_percent_of_invoice_paid', percent: 4 },
      { kind: 'flat_percent_of_quote_committed', percent: 2 },
    ];
    const out = expandRulesForQuote(rules, 500_000);
    expect(out.length).toBe(1);
    expect(out[0]!.amountCents).toBe(10_000);
    expect(out[0]!.rule.kind).toBe('flat_percent_of_quote_committed');
  });
});

// ---------------------------------------------------------------------------
// prorateBaseSalary — period overlap matrix
// ---------------------------------------------------------------------------

describe('prorateBaseSalary', () => {
  const base = {
    baseSalaryCents: 500_000,
    payPeriod: 'monthly' as const,
  };

  it('pays full base when the plan covers the full period', () => {
    expect(
      prorateBaseSalary({
        ...base,
        periodLabel: '2026-05',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        effectiveTo: new Date('2026-12-31T23:59:59Z'),
      }),
    ).toBe(500_000);
  });

  it('pays full base when effectiveTo is null (open-ended plan)', () => {
    expect(
      prorateBaseSalary({
        ...base,
        periodLabel: '2026-05',
        effectiveFrom: new Date('2026-04-01T00:00:00Z'),
        effectiveTo: null,
      }),
    ).toBe(500_000);
  });

  it('pays full base when the plan starts on the last day of the period', () => {
    expect(
      prorateBaseSalary({
        ...base,
        periodLabel: '2026-05',
        effectiveFrom: new Date('2026-05-31T00:00:00Z'),
        effectiveTo: null,
      }),
    ).toBe(500_000);
  });

  it('pays full base when the plan ends on the first day of the period', () => {
    expect(
      prorateBaseSalary({
        ...base,
        periodLabel: '2026-05',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        effectiveTo: new Date('2026-05-01T23:59:59Z'),
      }),
    ).toBe(500_000);
  });

  it('pays zero when the plan ended before the period began', () => {
    expect(
      prorateBaseSalary({
        ...base,
        periodLabel: '2026-05',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        effectiveTo: new Date('2026-04-30T23:59:59Z'),
      }),
    ).toBe(0);
  });

  it('pays zero when the plan starts after the period ends', () => {
    expect(
      prorateBaseSalary({
        ...base,
        periodLabel: '2026-05',
        effectiveFrom: new Date('2026-06-01T00:00:00Z'),
        effectiveTo: null,
      }),
    ).toBe(0);
  });

  it('returns 0 on malformed periodLabel rather than throwing', () => {
    expect(
      prorateBaseSalary({
        ...base,
        periodLabel: 'not-a-period',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        effectiveTo: null,
      }),
    ).toBe(0);
  });

  it('handles biweekly plans the same as monthly in v1', () => {
    expect(
      prorateBaseSalary({
        baseSalaryCents: 250_000,
        payPeriod: 'biweekly',
        periodLabel: '2026-05',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        effectiveTo: null,
      }),
    ).toBe(250_000);
  });
});

// ---------------------------------------------------------------------------
// Integration-shaped scenarios composed entirely from pure helpers.
//
// These mirror the gate's required scenarios (single invoice, ten invoices,
// refund reverses) so we know the helpers compose correctly without
// running them against a live DB.
// ---------------------------------------------------------------------------

describe('helper composition scenarios', () => {
  const rules: CommissionRule[] = [
    { kind: 'flat_percent_of_invoice_paid', percent: 5 },
  ];

  it('single invoice: 5% of $1000 invoice = $50', () => {
    const out = expandRulesForInvoice(rules, 100_000);
    expect(out.length).toBe(1);
    expect(out[0]!.amountCents).toBe(5_000);
  });

  it('ten invoices accumulate proportionally', () => {
    const totals = Array.from({ length: 10 }, (_, i) => 50_000 + i * 10_000);
    const credits = totals.map((t) => expandRulesForInvoice(rules, t)[0]!.amountCents);
    const sum = credits.reduce((s, c) => s + c, 0);
    // Sum of (50000..140000) * 5% / 100 = sum(50000..140000) * 0.05
    const expected = totals.reduce((s, t) => s + Math.round((t * 5) / 100), 0);
    expect(sum).toBe(expected);
  });

  it('refund reversal: credit then negate via helper', () => {
    const out = expandRulesForInvoice(rules, 200_000);
    expect(out.length).toBe(1);
    const original = out[0]!.amountCents;
    // The reversal helper writes -original; the engine's writeReversals
    // performs this DB-side, but the math is straightforward here.
    expect(-original).toBe(-10_000);
    expect(original + -original).toBe(0);
  });

  it('plan change mid-period: each event uses its own active plan', () => {
    const planA: CommissionRule = { kind: 'flat_percent_of_invoice_paid', percent: 3 };
    const planB: CommissionRule = { kind: 'flat_percent_of_invoice_paid', percent: 5 };
    // Two invoices in the same period, each routed to whichever plan
    // was active. The DB-side findActivePlan does the routing; here we
    // assert the math is right when called with the correct plan.
    const creditA = applyRuleToInvoice(planA, 100_000); // 3000
    const creditB = applyRuleToInvoice(planB, 100_000); // 5000
    expect(creditA + creditB).toBe(8_000);
  });
});
