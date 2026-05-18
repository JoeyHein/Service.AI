/**
 * Boundary tests for the comp plan + commission rule schemas (CHR-04).
 *
 * Table-driven coverage stands in for property-based testing here: each
 * rule kind has a matrix of valid + invalid cases that exercise the
 * boundary conditions the schemas were designed to reject. The matrix
 * is deliberately verbose — every entry encodes one acceptance criterion
 * from the gate doc.
 *
 * What the matrix covers per rule kind:
 *   1. valid at lower bound (percent = 0, floorCents = 0)
 *   2. valid at upper bound (percent = 100)
 *   3. valid in the middle
 *   4. invalid: percent < 0
 *   5. invalid: percent > 100
 *   6. invalid: non-numeric / NaN percent
 *   7. invalid: missing required field
 *   8. invalid: extra field (Zod .strict() rejects unknown keys)
 *
 * The tiered rule adds:
 *   9. invalid: empty tier array
 *  10. invalid: first tier floor != 0
 *  11. invalid: unsorted tiers
 *  12. invalid: duplicate floor values
 *  13. valid: tiers ascending with non-zero gaps
 *
 * The comp plan record adds:
 *  14. invalid: commission_only with baseSalaryCents > 0
 *  15. invalid: effectiveTo before effectiveFrom
 *  16. valid: long-tenure plan (effectiveFrom = today, effectiveTo = null)
 *  17. invalid: bad date format
 */
import { describe, expect, it } from 'vitest';
import {
  parseCommissionRule,
  parseCompPlan,
  tierPercentForAmount,
  type CommissionRule,
  type CompPlan,
  type TieredPercentOfInvoicePaid,
} from '../comp-plans.js';

// ---------------------------------------------------------------------------
// flat_percent_of_invoice_paid
// ---------------------------------------------------------------------------

describe('flat_percent_of_invoice_paid', () => {
  it.each([
    { percent: 0 },
    { percent: 0.5 },
    { percent: 4 },
    { percent: 50 },
    { percent: 99.99 },
    { percent: 100 },
  ])('accepts percent=$percent', ({ percent }) => {
    expect(() =>
      parseCommissionRule({ kind: 'flat_percent_of_invoice_paid', percent }),
    ).not.toThrow();
  });

  it.each([
    { name: 'negative percent', input: { kind: 'flat_percent_of_invoice_paid', percent: -1 } },
    { name: 'percent > 100', input: { kind: 'flat_percent_of_invoice_paid', percent: 101 } },
    { name: 'NaN percent', input: { kind: 'flat_percent_of_invoice_paid', percent: Number.NaN } },
    { name: 'string percent', input: { kind: 'flat_percent_of_invoice_paid', percent: '4' } },
    { name: 'missing percent', input: { kind: 'flat_percent_of_invoice_paid' } },
    {
      name: 'extra field',
      input: { kind: 'flat_percent_of_invoice_paid', percent: 4, extra: 'no' },
    },
  ])('rejects $name', ({ input }) => {
    expect(() => parseCommissionRule(input)).toThrowError(/INVALID_COMMISSION_RULE|.*/);
  });
});

// ---------------------------------------------------------------------------
// tiered_percent_of_invoice_paid
// ---------------------------------------------------------------------------

describe('tiered_percent_of_invoice_paid', () => {
  it('accepts a single zero-floor tier', () => {
    const rule = parseCommissionRule({
      kind: 'tiered_percent_of_invoice_paid',
      tiers: [{ floorCents: 0, percent: 4 }],
    });
    expect(rule.kind).toBe('tiered_percent_of_invoice_paid');
  });

  it('accepts a standard ascending tier ladder', () => {
    expect(() =>
      parseCommissionRule({
        kind: 'tiered_percent_of_invoice_paid',
        tiers: [
          { floorCents: 0, percent: 3 },
          { floorCents: 50000, percent: 4 },
          { floorCents: 250000, percent: 5 },
          { floorCents: 1000000, percent: 6 },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects an empty tier array', () => {
    expect(() =>
      parseCommissionRule({
        kind: 'tiered_percent_of_invoice_paid',
        tiers: [],
      }),
    ).toThrow();
  });

  it('rejects a first tier whose floor is non-zero', () => {
    expect(() =>
      parseCommissionRule({
        kind: 'tiered_percent_of_invoice_paid',
        tiers: [{ floorCents: 1000, percent: 4 }],
      }),
    ).toThrow();
  });

  it('rejects tiers sorted descending', () => {
    expect(() =>
      parseCommissionRule({
        kind: 'tiered_percent_of_invoice_paid',
        tiers: [
          { floorCents: 0, percent: 3 },
          { floorCents: 100000, percent: 5 },
          { floorCents: 50000, percent: 4 },
        ],
      }),
    ).toThrow();
  });

  it('rejects duplicate tier floors', () => {
    expect(() =>
      parseCommissionRule({
        kind: 'tiered_percent_of_invoice_paid',
        tiers: [
          { floorCents: 0, percent: 3 },
          { floorCents: 50000, percent: 4 },
          { floorCents: 50000, percent: 5 },
        ],
      }),
    ).toThrow();
  });

  it('rejects negative floorCents', () => {
    expect(() =>
      parseCommissionRule({
        kind: 'tiered_percent_of_invoice_paid',
        tiers: [{ floorCents: -1, percent: 4 }],
      }),
    ).toThrow();
  });

  it('rejects non-integer floorCents', () => {
    expect(() =>
      parseCommissionRule({
        kind: 'tiered_percent_of_invoice_paid',
        tiers: [{ floorCents: 100.5, percent: 4 }],
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// tierPercentForAmount — domain helper used by the commission engine (CHR-05)
// ---------------------------------------------------------------------------

describe('tierPercentForAmount', () => {
  const rule: TieredPercentOfInvoicePaid = {
    kind: 'tiered_percent_of_invoice_paid',
    tiers: [
      { floorCents: 0, percent: 3 },
      { floorCents: 50000, percent: 4 },
      { floorCents: 250000, percent: 5 },
      { floorCents: 1000000, percent: 6 },
    ],
  };

  it.each([
    { amountCents: 0, expected: 3 },
    { amountCents: 1, expected: 3 },
    { amountCents: 49999, expected: 3 },
    { amountCents: 50000, expected: 4 },
    { amountCents: 50001, expected: 4 },
    { amountCents: 249999, expected: 4 },
    { amountCents: 250000, expected: 5 },
    { amountCents: 999999, expected: 5 },
    { amountCents: 1000000, expected: 6 },
    { amountCents: 9999999, expected: 6 },
  ])(
    'returns $expected%% for $amountCents cents',
    ({ amountCents, expected }) => {
      expect(tierPercentForAmount(rule, amountCents)).toBe(expected);
    },
  );
});

// ---------------------------------------------------------------------------
// flat_percent_of_quote_committed
// ---------------------------------------------------------------------------

describe('flat_percent_of_quote_committed', () => {
  it.each([
    { percent: 0 },
    { percent: 2.5 },
    { percent: 10 },
    { percent: 100 },
  ])('accepts percent=$percent', ({ percent }) => {
    expect(() =>
      parseCommissionRule({ kind: 'flat_percent_of_quote_committed', percent }),
    ).not.toThrow();
  });

  it.each([
    { name: 'negative', percent: -0.01 },
    { name: 'over 100', percent: 100.01 },
    { name: 'NaN', percent: Number.NaN },
  ])('rejects $name percent', ({ percent }) => {
    expect(() =>
      parseCommissionRule({ kind: 'flat_percent_of_quote_committed', percent }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// discriminated-union rejection of unknown kinds
// ---------------------------------------------------------------------------

describe('commissionRuleSchema discriminated union', () => {
  it('rejects an unknown kind', () => {
    expect(() =>
      parseCommissionRule({ kind: 'flat_amount_per_job', percent: 5 }),
    ).toThrow();
  });

  it('rejects missing kind', () => {
    expect(() => parseCommissionRule({ percent: 5 })).toThrow();
  });

  it('rejects null / non-object input', () => {
    expect(() => parseCommissionRule(null)).toThrow();
    expect(() => parseCommissionRule(42)).toThrow();
    expect(() => parseCommissionRule('flat_percent_of_invoice_paid')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CompPlan record
// ---------------------------------------------------------------------------

describe('compPlanSchema', () => {
  const goodBase = {
    name: 'Manager — Standard',
    kind: 'base_plus_commission' as const,
    baseSalaryCents: 500000,
    payPeriod: 'monthly' as const,
    commissionRules: [
      { kind: 'flat_percent_of_invoice_paid', percent: 4 } as CommissionRule,
    ],
    effectiveFrom: '2026-06-01',
  };

  it('accepts a standard base+commission plan', () => {
    expect(() => parseCompPlan(goodBase)).not.toThrow();
  });

  it('accepts a commission_only plan with zero base', () => {
    expect(() =>
      parseCompPlan({ ...goodBase, kind: 'commission_only', baseSalaryCents: 0 }),
    ).not.toThrow();
  });

  it('rejects commission_only with non-zero base', () => {
    expect(() =>
      parseCompPlan({ ...goodBase, kind: 'commission_only', baseSalaryCents: 1 }),
    ).toThrow();
  });

  it('accepts an open-ended plan (no effectiveTo)', () => {
    expect(() =>
      parseCompPlan({ ...goodBase, effectiveTo: null }),
    ).not.toThrow();
  });

  it('accepts plan with multiple stacked rules', () => {
    expect(() =>
      parseCompPlan({
        ...goodBase,
        commissionRules: [
          { kind: 'flat_percent_of_invoice_paid', percent: 4 },
          { kind: 'flat_percent_of_quote_committed', percent: 2 },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects effectiveTo before effectiveFrom', () => {
    expect(() =>
      parseCompPlan({
        ...goodBase,
        effectiveFrom: '2026-06-01',
        effectiveTo: '2026-05-31',
      }),
    ).toThrow();
  });

  it.each([
    { name: 'bad date format', field: 'effectiveFrom', value: '2026/06/01' },
    { name: 'short date', field: 'effectiveFrom', value: '2026-6-1' },
    { name: 'empty name', field: 'name', value: '' },
    { name: 'over-long name', field: 'name', value: 'x'.repeat(121) },
    { name: 'unknown payPeriod', field: 'payPeriod', value: 'quarterly' },
    { name: 'negative base salary', field: 'baseSalaryCents', value: -100 },
    { name: 'non-integer base salary', field: 'baseSalaryCents', value: 100.5 },
  ])('rejects $name', ({ field, value }) => {
    expect(() => parseCompPlan({ ...goodBase, [field]: value })).toThrow();
  });

  it('rejects empty commissionRules array', () => {
    expect(() =>
      parseCompPlan({ ...goodBase, commissionRules: [] }),
    ).toThrow();
  });

  it('rejects extra unknown fields at the top level', () => {
    expect(() =>
      parseCompPlan({ ...goodBase, payrollProvider: 'gusto' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseCompPlan throws structured CompPlanValidationError, not bare ZodError
// ---------------------------------------------------------------------------

describe('parseCompPlan error shape', () => {
  it('throws structured INVALID_COMP_PLAN with field-level details', () => {
    try {
      parseCompPlan({ kind: 'commission_only', baseSalaryCents: 1 });
      throw new Error('expected throw');
    } catch (err: unknown) {
      const e = err as { code?: string; details?: unknown[] };
      expect(e.code).toBe('INVALID_COMP_PLAN');
      expect(Array.isArray(e.details)).toBe(true);
      expect((e.details ?? []).length).toBeGreaterThan(0);
    }
  });

  it('throws structured INVALID_COMMISSION_RULE on rule parse failure', () => {
    try {
      parseCommissionRule({ kind: 'flat_percent_of_invoice_paid', percent: 999 });
      throw new Error('expected throw');
    } catch (err: unknown) {
      const e = err as { code?: string; details?: unknown[] };
      expect(e.code).toBe('INVALID_COMMISSION_RULE');
      expect((e.details ?? []).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// TypeScript inference smoke test (compile-time only)
// ---------------------------------------------------------------------------

describe('type inference', () => {
  it('infers discriminated union members correctly', () => {
    const rule: CommissionRule = parseCommissionRule({
      kind: 'flat_percent_of_invoice_paid',
      percent: 4,
    });
    if (rule.kind === 'flat_percent_of_invoice_paid') {
      // Compiler must see `percent` on this branch.
      const _check: number = rule.percent;
      expect(_check).toBe(4);
    } else {
      throw new Error('discriminator narrowing broken');
    }
  });

  it('CompPlan type carries every required field', () => {
    const plan: CompPlan = parseCompPlan({
      name: 'X',
      kind: 'base_plus_commission',
      baseSalaryCents: 0,
      payPeriod: 'monthly',
      commissionRules: [{ kind: 'flat_percent_of_invoice_paid', percent: 0 }],
      effectiveFrom: '2026-06-01',
    });
    expect(plan.name).toBe('X');
    expect(plan.commissionRules.length).toBe(1);
  });
});
