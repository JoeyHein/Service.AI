/**
 * Royalty rule engine (phase_royalty_engine).
 *
 * A pure function module that converts a franchisee's ordered
 * rule set + an invoice context into a single `applicationFeeCents`
 * number. Pure so it's trivially testable and can be reused by
 * the monthly statement projector too (to compute royaltyOwed).
 *
 * Rule types — params shapes:
 *
 *   percentage        { basisPoints: 1000 = 10% }
 *   flat_per_job      { amountCents: 2500 = $25 }
 *   tiered            { tiers: [
 *                         { upToCents: 5000000, basisPoints: 1000 },
 *                         { upToCents: null,    basisPoints: 500  }
 *                       ] }
 *                     The last tier uses upToCents=null to mean
 *                     "everything above the previous tier".
 *   minimum_floor     { perMonthCents: 50000 = $500 }
 *
 * Composition:
 *
 *   Each rule applies in sort_order to a running fee total. The
 *   minimum_floor rule is special — it bumps the current fee up
 *   to the floor, clamped to `totalCents` so the fee never
 *   exceeds the invoice amount. Everything else adds to the fee.
 *
 * Context:
 *
 *   totalCents               — this invoice's pre-fee total
 *   jobCountThisMonth        — jobs already billed (0-indexed;
 *                              caller increments after each
 *                              successful finalize)
 *   monthGrossCents          — gross revenue already booked for
 *                              the franchisee in the period
 *                              (used by `tiered`)
 *   monthFeesAccruedCents    — royalty already accrued this
 *                              period (used by `minimum_floor`
 *                              to decide how much extra is owed)
 */

export type RuleType =
  | 'percentage'
  | 'flat_per_job'
  | 'tiered'
  | 'minimum_floor';

export interface PercentageParams {
  basisPoints: number;
}

export interface FlatPerJobParams {
  amountCents: number;
}

export interface TierSpec {
  /** null means "no upper bound" — always the last tier. */
  upToCents: number | null;
  basisPoints: number;
}

export interface TieredParams {
  tiers: TierSpec[];
}

export interface MinimumFloorParams {
  perMonthCents: number;
}

export type RuleParams =
  | { type: 'percentage'; params: PercentageParams }
  | { type: 'flat_per_job'; params: FlatPerJobParams }
  | { type: 'tiered'; params: TieredParams }
  | { type: 'minimum_floor'; params: MinimumFloorParams };

export interface ResolveContext {
  totalCents: number;
  jobCountThisMonth: number;
  monthGrossCents: number;
  monthFeesAccruedCents: number;
}

/** The storage shape — `params` is a structured JSON blob. */
export interface StoredRule {
  id?: string;
  ruleType: RuleType;
  params: unknown;
  sortOrder: number;
}

function applyPercentage(feeSoFar: number, total: number, bps: number): number {
  return feeSoFar + Math.round((total * bps) / 10000);
}

function applyFlat(feeSoFar: number, amountCents: number): number {
  return feeSoFar + Math.max(0, Math.round(amountCents));
}

function applyTiered(
  feeSoFar: number,
  ctx: ResolveContext,
  tiers: TierSpec[],
): number {
  // Applied to the *incremental* revenue from this invoice.
  // For each tier, figure out how much of totalCents falls into
  // that tier, multiply by the tier's bps, and sum.
  let remaining = ctx.totalCents;
  let cursor = ctx.monthGrossCents; // starting position in the cumulative curve
  let extra = 0;
  for (const tier of tiers) {
    if (remaining <= 0) break;
    const upper = tier.upToCents === null ? Number.POSITIVE_INFINITY : tier.upToCents;
    const capacity = Math.max(0, upper - cursor);
    const applicable = Math.min(remaining, capacity);
    if (applicable > 0) {
      extra += Math.round((applicable * tier.basisPoints) / 10000);
      remaining -= applicable;
      cursor += applicable;
    } else if (capacity === 0) {
      // We're at or past this tier's ceiling — skip.
      continue;
    }
  }
  return feeSoFar + extra;
}

function applyFloor(
  feeSoFar: number,
  ctx: ResolveContext,
  perMonthCents: number,
): number {
  const projectedTotal = ctx.monthFeesAccruedCents + feeSoFar;
  if (projectedTotal >= perMonthCents) return feeSoFar;
  const gap = perMonthCents - projectedTotal;
  // Clamp: never make the fee exceed the invoice total.
  const capped = Math.min(gap, ctx.totalCents - feeSoFar);
  return feeSoFar + Math.max(0, capped);
}

/**
 * Core dispatcher. Exposed as-is so the statement generator can
 * call it against every rule in a franchisee's active agreement
 * and reproduce historical fees deterministically.
 *
 * Throws on a malformed rule — the API layer validates with Zod
 * before insert so this path is only hit by hand-crafted tests.
 */
export function resolveFeeCents(
  rules: StoredRule[],
  ctx: ResolveContext,
): number {
  if (ctx.totalCents <= 0) return 0;
  const ordered = [...rules].sort((a, b) => a.sortOrder - b.sortOrder);
  let fee = 0;
  for (const rule of ordered) {
    switch (rule.ruleType) {
      case 'percentage': {
        const p = rule.params as PercentageParams;
        if (typeof p?.basisPoints !== 'number')
          throw new Error('percentage rule: params.basisPoints required');
        fee = applyPercentage(fee, ctx.totalCents, p.basisPoints);
        break;
      }
      case 'flat_per_job': {
        const p = rule.params as FlatPerJobParams;
        if (typeof p?.amountCents !== 'number')
          throw new Error('flat_per_job rule: params.amountCents required');
        fee = applyFlat(fee, p.amountCents);
        break;
      }
      case 'tiered': {
        const p = rule.params as TieredParams;
        if (!Array.isArray(p?.tiers) || p.tiers.length === 0)
          throw new Error('tiered rule: params.tiers must be a non-empty array');
        fee = applyTiered(fee, ctx, p.tiers);
        break;
      }
      case 'minimum_floor': {
        const p = rule.params as MinimumFloorParams;
        if (typeof p?.perMonthCents !== 'number')
          throw new Error('minimum_floor rule: params.perMonthCents required');
        fee = applyFloor(fee, ctx, p.perMonthCents);
        break;
      }
      default: {
        // Exhaustive check so new rule types force a compile
        // error in this switch.
        const exhaustiveCheck: never = rule.ruleType as never;
        throw new Error(`Unknown rule type: ${exhaustiveCheck as string}`);
      }
    }
  }
  // Clamp to invoice total as a final safety rail.
  return Math.max(0, Math.min(fee, ctx.totalCents));
}

/**
 * The phase-7 default when no agreement is configured: a flat
 * 5% of the invoice total. Kept here so finalize + tests share
 * one definition.
 */
export const DEFAULT_FALLBACK_BPS = 500;

export function defaultFallbackFeeCents(totalCents: number): number {
  return Math.round((totalCents * DEFAULT_FALLBACK_BPS) / 10000);
}
