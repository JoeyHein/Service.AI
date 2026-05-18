/**
 * Margin engine tests (SQB-07a).
 *
 * Covers the three-level resolution order including ties, bounds
 * enforcement on each resolution level, and totals aggregation.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveSellingPrice,
  totalsFor,
  type MarginPolicy,
} from '../margin-engine.js';

const POLICY: MarginPolicy = {
  defaultPct: 60,
  minPct: 20,
  maxPct: 200,
};

// ---------------------------------------------------------------------------
// Resolution order
// ---------------------------------------------------------------------------

describe('resolveSellingPrice resolution order', () => {
  it('uses corporate_default when no line + no category override', () => {
    const r = resolveSellingPrice({
      unitCostCents: 10_000,
      itemCategory: 'ALUMINIUM',
      policy: POLICY,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.marginSource).toBe('corporate_default');
    expect(r.marginPct).toBe(60);
    expect(r.unitPriceCents).toBe(16_000); // 10000 * 1.6
  });

  it('uses category override when present and no line override', () => {
    const r = resolveSellingPrice({
      unitCostCents: 10_000,
      itemCategory: 'ALUMINIUM',
      categoryMarginPct: 80,
      policy: POLICY,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.marginSource).toBe('category_override');
    expect(r.marginPct).toBe(80);
    expect(r.unitPriceCents).toBe(18_000);
  });

  it('line override wins over category override', () => {
    const r = resolveSellingPrice({
      unitCostCents: 10_000,
      itemCategory: 'ALUMINIUM',
      lineOverridePct: 50,
      categoryMarginPct: 80,
      policy: POLICY,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.marginSource).toBe('line_override');
    expect(r.marginPct).toBe(50);
    expect(r.unitPriceCents).toBe(15_000);
  });

  it('line override of 0 still wins over both — 0 is a valid choice', () => {
    const r = resolveSellingPrice({
      unitCostCents: 10_000,
      itemCategory: 'ALUMINIUM',
      lineOverridePct: 0,
      categoryMarginPct: 80,
      policy: POLICY,
    });
    // 0% margin is below the 20% minimum — out of bounds.
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('MARGIN_OUT_OF_BOUNDS');
  });

  it('line override of 0 wins when bounds permit', () => {
    const permissive: MarginPolicy = { defaultPct: 60, minPct: 0, maxPct: 200 };
    const r = resolveSellingPrice({
      unitCostCents: 10_000,
      itemCategory: 'ALUMINIUM',
      lineOverridePct: 0,
      categoryMarginPct: 80,
      policy: permissive,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.marginSource).toBe('line_override');
    expect(r.marginPct).toBe(0);
    expect(r.unitPriceCents).toBe(10_000); // cost = price
  });

  it('category override of 0 wins when no line override and bounds permit', () => {
    const permissive: MarginPolicy = { defaultPct: 60, minPct: 0, maxPct: 200 };
    const r = resolveSellingPrice({
      unitCostCents: 10_000,
      itemCategory: 'SAMPLE',
      categoryMarginPct: 0,
      policy: permissive,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.marginSource).toBe('category_override');
    expect(r.marginPct).toBe(0);
  });

  it('null line override falls through to category', () => {
    const r = resolveSellingPrice({
      unitCostCents: 10_000,
      itemCategory: 'ALUMINIUM',
      lineOverridePct: null,
      categoryMarginPct: 80,
      policy: POLICY,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.marginSource).toBe('category_override');
  });

  it('undefined category falls through to corporate default', () => {
    const r = resolveSellingPrice({
      unitCostCents: 10_000,
      itemCategory: null,
      policy: POLICY,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.marginSource).toBe('corporate_default');
  });
});

// ---------------------------------------------------------------------------
// Bounds enforcement
// ---------------------------------------------------------------------------

describe('resolveSellingPrice bounds', () => {
  it('rejects line override below floor', () => {
    const r = resolveSellingPrice({
      unitCostCents: 10_000,
      itemCategory: null,
      lineOverridePct: 10,
      policy: POLICY,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('MARGIN_OUT_OF_BOUNDS');
    expect(r.message).toMatch(/10% is below the minimum 20%/);
  });

  it('rejects line override above ceiling', () => {
    const r = resolveSellingPrice({
      unitCostCents: 10_000,
      itemCategory: null,
      lineOverridePct: 250,
      policy: POLICY,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('MARGIN_OUT_OF_BOUNDS');
    expect(r.message).toMatch(/250% is above the maximum 200%/);
  });

  it('rejects category override below floor', () => {
    const r = resolveSellingPrice({
      unitCostCents: 10_000,
      itemCategory: 'SAMPLE',
      categoryMarginPct: 5,
      policy: POLICY,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('MARGIN_OUT_OF_BOUNDS');
  });

  it('rejects misconfigured corporate default that violates its own bounds', () => {
    const r = resolveSellingPrice({
      unitCostCents: 10_000,
      itemCategory: null,
      policy: { defaultPct: 5, minPct: 20, maxPct: 200 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('MARGIN_OUT_OF_BOUNDS');
  });

  it('accepts exactly-at-floor margin', () => {
    const r = resolveSellingPrice({
      unitCostCents: 10_000,
      itemCategory: null,
      lineOverridePct: 20,
      policy: POLICY,
    });
    expect(r.ok).toBe(true);
  });

  it('accepts exactly-at-ceiling margin', () => {
    const r = resolveSellingPrice({
      unitCostCents: 10_000,
      itemCategory: null,
      lineOverridePct: 200,
      policy: POLICY,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unitPriceCents).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// Cost validation
// ---------------------------------------------------------------------------

describe('resolveSellingPrice cost validation', () => {
  it.each([
    { name: 'negative', value: -1 },
    { name: 'NaN', value: Number.NaN },
    { name: 'Infinity', value: Number.POSITIVE_INFINITY },
  ])('rejects $name unit_cost_cents', ({ value }) => {
    const r = resolveSellingPrice({
      unitCostCents: value,
      itemCategory: null,
      policy: POLICY,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('INVALID_COST');
  });

  it('accepts zero cost (sell at zero — admin priced freebie)', () => {
    const r = resolveSellingPrice({
      unitCostCents: 0,
      itemCategory: null,
      policy: POLICY,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unitPriceCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------

describe('resolveSellingPrice rounding', () => {
  it.each([
    { cost: 100, pct: 60, expected: 160 },
    { cost: 333, pct: 33, expected: 443 }, // 333 * 1.33 = 442.89
    { cost: 12_345, pct: 60, expected: 19_752 }, // 12345 * 1.6 = 19752.0
    { cost: 99_999, pct: 75, expected: 174_998 }, // 99999 * 1.75 = 174998.25
  ])('cost=$cost pct=$pct → $expected', ({ cost, pct, expected }) => {
    const r = resolveSellingPrice({
      unitCostCents: cost,
      itemCategory: null,
      lineOverridePct: pct,
      policy: { defaultPct: 60, minPct: 0, maxPct: 1000 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unitPriceCents).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// totalsFor
// ---------------------------------------------------------------------------

describe('totalsFor', () => {
  it('aggregates unit price × quantity across lines', () => {
    const t = totalsFor([
      { unitPriceCents: 10_000, quantity: 3 },
      { unitPriceCents: 25_000, quantity: 1 },
    ]);
    expect(t.subtotalCents).toBe(55_000);
    expect(t.taxCents).toBe(0);
    expect(t.totalCents).toBe(55_000);
  });

  it('returns zeros for empty input', () => {
    const t = totalsFor([]);
    expect(t.subtotalCents).toBe(0);
    expect(t.totalCents).toBe(0);
  });
});
