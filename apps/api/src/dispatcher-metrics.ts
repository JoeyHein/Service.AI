/**
 * Dispatcher metrics rollup (TASK-DI-07).
 *
 * `computeDailyAiMetrics` reads `ai_suggestions` for a
 * (franchiseeId, UTC-day) window and upserts a single
 * `ai_metrics` row. Pure-ish — side effects are a single
 * insert-or-update in the caller's transaction so the endpoint
 * handler can wrap it in withScope.
 */

import { and, eq, gte, lt } from 'drizzle-orm';
import { aiMetrics, aiSuggestions, type ScopedTx } from '@service-ai/db';

export interface DailyAiMetricsInput {
  tx: ScopedTx;
  franchiseeId: string;
  /** UTC-midnight instant for the day being rolled up. */
  date: Date;
}

export interface DailyAiMetricsOutput {
  id: string;
  suggestionsTotal: number;
  autoApplied: number;
  queued: number;
  approved: number;
  rejected: number;
  overrideRate: string;
}

function utcMidnight(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      0, 0, 0, 0,
    ),
  );
}

export async function computeDailyAiMetrics(
  input: DailyAiMetricsInput,
): Promise<DailyAiMetricsOutput> {
  const start = utcMidnight(input.date);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const rows = await input.tx
    .select()
    .from(aiSuggestions)
    .where(
      and(
        eq(aiSuggestions.franchiseeId, input.franchiseeId),
        gte(aiSuggestions.createdAt, start),
        lt(aiSuggestions.createdAt, end),
      ),
    );
  const total = rows.length;
  const autoApplied = rows.filter((r) => r.status === 'applied').length;
  const queued = rows.filter((r) => r.status === 'pending').length;
  const approved = rows.filter((r) => r.status === 'approved').length;
  const rejected = rows.filter((r) => r.status === 'rejected').length;
  // Override rate = fraction of auto-applied (or approved) rows
  // that ended up rejected by a human. For v1 we approximate as
  // rejected / total so the number is computable from a single
  // day's aiSuggestions rows.
  const overrideRate = total === 0 ? 0 : rejected / total;

  const existing = await input.tx
    .select()
    .from(aiMetrics)
    .where(
      and(
        eq(aiMetrics.franchiseeId, input.franchiseeId),
        eq(aiMetrics.date, start),
      ),
    );
  const values = {
    suggestionsTotal: total,
    autoApplied,
    queued,
    approved,
    rejected,
    overrideRate: overrideRate.toFixed(4),
    updatedAt: new Date(),
  };
  let row: typeof aiMetrics.$inferSelect;
  if (existing[0]) {
    const updated = await input.tx
      .update(aiMetrics)
      .set(values)
      .where(eq(aiMetrics.id, existing[0].id))
      .returning();
    row = updated[0]!;
  } else {
    const inserted = await input.tx
      .insert(aiMetrics)
      .values({
        franchiseeId: input.franchiseeId,
        date: start,
        ...values,
      })
      .returning();
    row = inserted[0]!;
  }
  return {
    id: row.id,
    suggestionsTotal: row.suggestionsTotal,
    autoApplied: row.autoApplied,
    queued: row.queued,
    approved: row.approved,
    rejected: row.rejected,
    overrideRate: row.overrideRate,
  };
}
