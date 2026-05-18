/**
 * Margin engine (SQB-07).
 *
 * Resolves the selling price for a single quote line by applying a
 * three-level fallback ladder:
 *
 *     line override (manager-set per-line)
 *         → category override (margin_overrides keyed by BC itemCategoryCode)
 *             → corporate.default_margin_pct
 *
 * The formula is the multiplicative form managers actually reason
 * about:
 *
 *     unit_price_cents = round(unit_cost_cents * (1 + pct / 100))
 *
 * That's a deliberate choice over the divisive form OPENDC's legacy
 * margin engine uses (`price = cost / (1 - margin/100)`) — it's the
 * form people type into spreadsheets, and a 50% margin here means
 * "50% on cost" rather than "50% gross margin." The legacy form stays
 * in BC AI Agent for the GNB Manitoba pricing grid; the corporate
 * hub model uses the multiplicative form everywhere SQB touches.
 *
 * Cost is NEVER trusted from the client. The route handler re-fetches
 * `unit_cost_cents` from the supplier provider on every price call;
 * `resolveSellingPrice` only does the math.
 *
 * Bounds (`corporate.min_margin_pct` / `corporate.max_margin_pct`) are
 * enforced on the effective margin AFTER the resolution order. A line
 * override below the floor or above the ceiling returns
 * `MARGIN_OUT_OF_BOUNDS` so the route can surface 422.
 */

export type MarginSource = 'line_override' | 'category_override' | 'corporate_default';

export interface MarginPolicy {
  /** From `corporate.default_margin_pct`. Always populated. */
  defaultPct: number;
  /** Hard floor — overrides below this are rejected. */
  minPct: number;
  /** Hard ceiling — overrides above this are rejected. */
  maxPct: number;
}

export interface ResolveInput {
  unitCostCents: number;
  /** BC itemCategoryCode (or equivalent). NULL means "no category override applies." */
  itemCategory: string | null;
  /** Per-line manager-set override. NULL means "no line override." */
  lineOverridePct?: number | null;
  /** category → margin_pct lookup. Pass the matching entry or undefined. */
  categoryMarginPct?: number | null;
  policy: MarginPolicy;
}

export type ResolveResult =
  | {
      ok: true;
      unitPriceCents: number;
      marginPct: number;
      marginSource: MarginSource;
    }
  | {
      ok: false;
      error: 'MARGIN_OUT_OF_BOUNDS' | 'INVALID_COST';
      message: string;
    };

/**
 * The resolver. Pure — no DB, no clock, no side effects. The caller
 * is responsible for:
 *   1. fetching `unit_cost_cents` from the supplier provider
 *   2. loading the matching `margin_overrides.margin_pct` row
 *      (if any) for the line's `item_category`
 *   3. reading `corporate.default_margin_pct / min_margin_pct /
 *      max_margin_pct` from the single corporate row
 *
 * The route layer plus the engine layer are the two halves; this
 * function is the engine.
 */
export function resolveSellingPrice(input: ResolveInput): ResolveResult {
  const { unitCostCents, lineOverridePct, categoryMarginPct, policy } = input;

  if (!Number.isFinite(unitCostCents) || unitCostCents < 0) {
    return {
      ok: false,
      error: 'INVALID_COST',
      message: 'unit_cost_cents must be a non-negative integer',
    };
  }

  // Resolution order — use Number.isFinite to keep 0 from being
  // mistaken for "missing." A line override of 0% IS a real choice
  // ("sell at cost, this is a relationship customer"), and it must
  // beat both the category and default values.
  let marginPct: number;
  let marginSource: MarginSource;
  if (lineOverridePct !== null && lineOverridePct !== undefined && Number.isFinite(lineOverridePct)) {
    marginPct = lineOverridePct;
    marginSource = 'line_override';
  } else if (
    categoryMarginPct !== null &&
    categoryMarginPct !== undefined &&
    Number.isFinite(categoryMarginPct)
  ) {
    marginPct = categoryMarginPct;
    marginSource = 'category_override';
  } else {
    marginPct = policy.defaultPct;
    marginSource = 'corporate_default';
  }

  // Bounds. Apply to whichever margin actually fired — including the
  // default, so a misconfigured corporate row gets caught at request
  // time rather than silently producing out-of-range prices.
  if (marginPct < policy.minPct) {
    return {
      ok: false,
      error: 'MARGIN_OUT_OF_BOUNDS',
      message: `margin ${marginPct}% is below the minimum ${policy.minPct}%`,
    };
  }
  if (marginPct > policy.maxPct) {
    return {
      ok: false,
      error: 'MARGIN_OUT_OF_BOUNDS',
      message: `margin ${marginPct}% is above the maximum ${policy.maxPct}%`,
    };
  }

  const unitPriceCents = Math.round(unitCostCents * (1 + marginPct / 100));
  return { ok: true, unitPriceCents, marginPct, marginSource };
}

/**
 * Sum a resolved-line set into totals. Pure helper used by the route
 * layer once every line has resolved. Tax stays at 0 cents in v1 —
 * tax computation happens at the corporate-Stripe layer, not here.
 */
export interface ResolvedLine {
  unitPriceCents: number;
  quantity: number;
}

export interface QuoteTotals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export function totalsFor(lines: ResolvedLine[]): QuoteTotals {
  const subtotal = lines.reduce(
    (sum, l) => sum + l.unitPriceCents * l.quantity,
    0,
  );
  return { subtotalCents: subtotal, taxCents: 0, totalCents: subtotal };
}
