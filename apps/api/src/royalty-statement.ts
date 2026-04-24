/**
 * Monthly royalty statement generation (phase_royalty_engine).
 *
 * Pure-ish module: the statement projector reads payments +
 * refunds inside a given period, computes totals, and upserts a
 * `royalty_statements` row keyed on
 * `(franchisee_id, period_start, period_end)`.
 *
 * Timezones:
 *   `generateMonthlyStatement` accepts `{ year, month, timezone }`
 *   and converts to UTC instants using `date-fns-tz`. The
 *   `timezone` is the franchisor's operational timezone (defaults
 *   to `America/Denver` for the Elevated Doors pilot) so a month
 *   boundary aligns with the franchisor's billing cycle, not UTC
 *   midnight.
 */

import { and, eq, gte, lt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { fromZonedTime } from 'date-fns-tz';
import { addMonths } from 'date-fns';
import {
  franchisees,
  franchiseAgreements,
  royaltyRules,
  royaltyStatements,
  payments,
  refunds,
  type ScopedTx,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import { resolveFeeCents, type StoredRule } from './royalty-engine.js';

type Drizzle = NodePgDatabase<typeof schema>;

export interface GenerateInput {
  franchiseeId: string;
  /** 4-digit year in the franchisor's timezone. */
  year: number;
  /** 1-based month (1 = January). */
  month: number;
  /** IANA timezone (e.g. "America/Denver"). Default: "America/Denver". */
  timezone?: string;
}

export interface GeneratedStatement {
  id: string;
  franchiseeId: string;
  franchisorId: string;
  periodStart: Date;
  periodEnd: Date;
  grossRevenue: string;
  refundTotal: string;
  netRevenue: string;
  royaltyOwed: string;
  royaltyCollected: string;
  variance: string;
  status: string;
  transferId: string | null;
}

/**
 * Compute the UTC-instant period bounds for a given
 * (year, month, timezone) triple. `periodStart` is the first
 * instant of the month in that zone; `periodEnd` is the first
 * instant of the following month (half-open `[start, end)`).
 */
export function periodBounds(
  year: number,
  month: number,
  timezone: string,
): { periodStart: Date; periodEnd: Date } {
  const start = fromZonedTime(
    `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-01T00:00:00`,
    timezone,
  );
  const nextMonth = addMonths(start, 1);
  return { periodStart: start, periodEnd: nextMonth };
}

function round2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * Core generator. Runs inside a caller-provided transaction so
 * the API handler can wrap it in `withScope` for RLS, and the
 * BullMQ worker can batch multiple statements atomically.
 */
export async function generateMonthlyStatement(
  tx: ScopedTx | Drizzle,
  input: GenerateInput,
): Promise<GeneratedStatement> {
  const tz = input.timezone ?? 'America/Denver';
  const { periodStart, periodEnd } = periodBounds(input.year, input.month, tz);

  const feRows = await tx
    .select()
    .from(franchisees)
    .where(eq(franchisees.id, input.franchiseeId));
  const franchisee = feRows[0];
  if (!franchisee) {
    throw new Error(`Franchisee ${input.franchiseeId} not found`);
  }

  // Gross = sum of payment amounts in period.
  const paymentRows = await tx
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.franchiseeId, franchisee.id),
        gte(payments.createdAt, periodStart),
        lt(payments.createdAt, periodEnd),
      ),
    );

  const refundRows = await tx
    .select()
    .from(refunds)
    .where(
      and(
        eq(refunds.franchiseeId, franchisee.id),
        gte(refunds.createdAt, periodStart),
        lt(refunds.createdAt, periodEnd),
      ),
    );

  let grossCents = 0;
  let collectedFeeCents = 0;
  for (const p of paymentRows) {
    grossCents += Math.round(Number(p.amount) * 100);
    collectedFeeCents += Math.round(Number(p.applicationFeeAmount) * 100);
  }
  let refundedCents = 0;
  for (const r of refundRows) {
    refundedCents += Math.round(Number(r.amount) * 100);
  }
  const netCents = grossCents - refundedCents;

  // Compute "owed" by rerunning the engine on the net-revenue
  // bucket. The real owed number for audit purposes is the
  // sum of the recorded application fees (collectedFeeCents) —
  // but we also want to show what the franchisor *would have*
  // billed under the current rule set, because fee changes
  // mid-month produce meaningful variance.
  const agreementRows = await tx
    .select()
    .from(franchiseAgreements)
    .where(
      and(
        eq(franchiseAgreements.franchiseeId, franchisee.id),
        eq(franchiseAgreements.status, 'active'),
      ),
    );
  const activeAgreement = agreementRows[0];
  let owedCents = 0;
  if (activeAgreement && netCents > 0) {
    const ruleRows = await tx
      .select()
      .from(royaltyRules)
      .where(eq(royaltyRules.agreementId, activeAgreement.id))
      .orderBy(royaltyRules.sortOrder);
    const stored: StoredRule[] = ruleRows.map((r) => ({
      id: r.id,
      ruleType: r.ruleType,
      params: r.params,
      sortOrder: r.sortOrder,
    }));
    owedCents = resolveFeeCents(stored, {
      totalCents: netCents,
      jobCountThisMonth: paymentRows.length,
      monthGrossCents: 0,
      monthFeesAccruedCents: 0,
    });
  } else if (!activeAgreement) {
    // Fall back to 5% for consistency with finalize.
    owedCents = Math.round(netCents * 0.05);
  }

  const varianceCents = owedCents - collectedFeeCents;

  // Upsert by (franchiseeId, periodStart, periodEnd).
  const existing = await tx
    .select()
    .from(royaltyStatements)
    .where(
      and(
        eq(royaltyStatements.franchiseeId, franchisee.id),
        eq(royaltyStatements.periodStart, periodStart),
        eq(royaltyStatements.periodEnd, periodEnd),
      ),
    );
  const now = new Date();
  const values = {
    grossRevenue: round2(grossCents / 100),
    refundTotal: round2(refundedCents / 100),
    netRevenue: round2(netCents / 100),
    royaltyOwed: round2(owedCents / 100),
    royaltyCollected: round2(collectedFeeCents / 100),
    variance: round2(varianceCents / 100),
    updatedAt: now,
  };
  let row: typeof royaltyStatements.$inferSelect;
  if (existing[0]) {
    const updated = await tx
      .update(royaltyStatements)
      .set(values)
      .where(eq(royaltyStatements.id, existing[0].id))
      .returning();
    row = updated[0]!;
  } else {
    const inserted = await tx
      .insert(royaltyStatements)
      .values({
        franchiseeId: franchisee.id,
        franchisorId: franchisee.franchisorId,
        periodStart,
        periodEnd,
        ...values,
      })
      .returning();
    row = inserted[0]!;
  }
  return {
    id: row.id,
    franchiseeId: row.franchiseeId,
    franchisorId: row.franchisorId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    grossRevenue: row.grossRevenue,
    refundTotal: row.refundTotal,
    netRevenue: row.netRevenue,
    royaltyOwed: row.royaltyOwed,
    royaltyCollected: row.royaltyCollected,
    variance: row.variance,
    status: row.status,
    transferId: row.transferId,
  };
}
