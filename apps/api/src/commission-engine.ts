/**
 * Commission engine (CHR-05).
 *
 * Two surfaces:
 *
 *   1. Transition functions
 *      - onInvoicePaid(invoiceId, tx)          — fires when an invoice
 *        status flips to 'paid'. Looks up the responsible user (v1: the
 *        branch's current manager), resolves their active comp plan as of
 *        the invoice.paidAt, applies every rule of kind
 *        'flat_percent_of_invoice_paid' / 'tiered_percent_of_invoice_paid',
 *        and writes one commission_ledger row per rule that fires.
 *
 *      - onQuoteCommitted(quoteId, tx)         — fires when a supplier
 *        quote transitions priced -> committed (SQB-07). Same lookup as
 *        above but applies 'flat_percent_of_quote_committed' rules, and
 *        credits `closer_user_id` (the user who clicked commit) instead
 *        of the branch manager.
 *
 *      - reverseInvoicePaid(invoiceId, tx)     — writes a balancing row
 *        with source_kind='manual_adjustment' and a negated amount when
 *        an invoice is refunded. Idempotent: replays do not write a
 *        second reversal.
 *
 *      - reverseQuoteCommitted(quoteId, tx)    — analogue for quote void.
 *
 *   2. Pure projector
 *      - computeCommission(tx, userId, periodLabel) — sums the
 *        commission_ledger for the user across the period plus the
 *        prorated base salary from their active comp plan. Returns a
 *        statement-ready aggregate the manager dashboard renders.
 *
 * Idempotency
 *   commission_ledger has a UNIQUE index on (user_id, source_kind,
 *   source_id) — see migration 0016. All inserts go through ON CONFLICT
 *   DO NOTHING so repeated calls cannot duplicate accrual.
 *
 * Snapshot
 *   Every ledger row carries `rule_snapshot` — the exact rule JSON that
 *   produced the amount. Monthly statements built from these rows survive
 *   later edits to the comp_plans table without changing historical totals.
 */
import { and, asc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import {
  branchManagers,
  commissionLedger,
  compPlans,
  invoices,
  userCompAssignments,
  type ScopedTx,
} from '@service-ai/db';
import {
  parseCommissionRule,
  tierPercentForAmount,
  type CommissionRule,
} from '@service-ai/contracts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LedgerSourceKind = 'invoice_paid' | 'quote_committed' | 'manual_adjustment';

export interface LedgerInsert {
  userId: string;
  branchId: string;
  sourceKind: LedgerSourceKind;
  sourceId: string;
  amountCents: number;
  ruleSnapshot: Record<string, unknown>;
  periodLabel: string;
}

export interface CommissionLineItem {
  sourceKind: LedgerSourceKind;
  sourceId: string;
  amountCents: number;
  ruleSnapshot: Record<string, unknown>;
}

export interface CommissionResult {
  period: string;
  baseSalaryCents: number;
  commissionCents: number;
  totalCents: number;
  lineItems: CommissionLineItem[];
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without a DB)
// ---------------------------------------------------------------------------

/** Build the YYYY-MM period label from a Date in UTC. */
export function periodLabelFor(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Apply a single commission rule to a paid invoice. Returns the credit in
 * cents (0 when the rule does not apply or yields 0). The function is
 * pure: no DB access, no clock. The amountCents argument is the full
 * invoice total in cents.
 */
export function applyRuleToInvoice(
  rule: CommissionRule,
  amountCents: number,
): number {
  if (amountCents <= 0) return 0;
  if (rule.kind === 'flat_percent_of_invoice_paid') {
    return Math.round((amountCents * rule.percent) / 100);
  }
  if (rule.kind === 'tiered_percent_of_invoice_paid') {
    const percent = tierPercentForAmount(rule, amountCents);
    return Math.round((amountCents * percent) / 100);
  }
  return 0;
}

/**
 * Apply a single rule to a committed quote. Same shape as the invoice
 * variant. Only `flat_percent_of_quote_committed` fires here.
 */
export function applyRuleToQuote(
  rule: CommissionRule,
  amountCents: number,
): number {
  if (amountCents <= 0) return 0;
  if (rule.kind === 'flat_percent_of_quote_committed') {
    return Math.round((amountCents * rule.percent) / 100);
  }
  return 0;
}

/**
 * Sum the commission a rule set produces for one source event. Used by
 * the transition functions to expand a multi-rule plan into N ledger
 * rows; this helper returns the per-rule contributions so the caller
 * can write one row per non-zero rule with its own rule_snapshot.
 */
export function expandRulesForInvoice(
  rules: CommissionRule[],
  amountCents: number,
): Array<{ rule: CommissionRule; amountCents: number }> {
  return rules
    .map((rule) => ({ rule, amountCents: applyRuleToInvoice(rule, amountCents) }))
    .filter((row) => row.amountCents !== 0);
}

export function expandRulesForQuote(
  rules: CommissionRule[],
  amountCents: number,
): Array<{ rule: CommissionRule; amountCents: number }> {
  return rules
    .map((rule) => ({ rule, amountCents: applyRuleToQuote(rule, amountCents) }))
    .filter((row) => row.amountCents !== 0);
}

/**
 * YYYY-MM string compare. Used to bucket effective_from/to against a
 * target period without parsing the dates twice.
 */
function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Compute the prorated base salary for a comp plan in a given period.
 * v1 model: if any day of the period falls inside the plan's
 * [effective_from, effective_to] interval, the full period base is paid.
 * Simpler than calendar-day proration and matches how field-service
 * branches actually run payroll. Returns 0 when no period day is covered.
 */
export function prorateBaseSalary(opts: {
  baseSalaryCents: number;
  payPeriod: 'monthly' | 'biweekly';
  periodLabel: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}): number {
  // First and last day of the period, UTC.
  const [yStr, mStr] = opts.periodLabel.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return 0;
  const periodStart = new Date(Date.UTC(y, m - 1, 1));
  const periodEnd = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));

  const effFrom = opts.effectiveFrom;
  const effTo = opts.effectiveTo ?? new Date('9999-12-31T23:59:59.999Z');

  // Any overlap?
  if (effFrom > periodEnd || effTo < periodStart) return 0;
  return opts.baseSalaryCents;
}

// ---------------------------------------------------------------------------
// DB-touching orchestration
// ---------------------------------------------------------------------------

/**
 * Resolve the active comp plan + commission rules for a user as of the
 * given event date. Returns null when the user has no overlapping
 * assignment. Internal — the transition functions call this once per
 * event.
 */
async function findActivePlan(
  tx: ScopedTx,
  userId: string,
  asOf: Date,
): Promise<{
  rules: CommissionRule[];
  baseSalaryCents: number;
  payPeriod: 'monthly' | 'biweekly';
  effectiveFrom: Date;
  effectiveTo: Date | null;
  planId: string;
} | null> {
  const asOfDate = dateOnly(asOf);
  const rows = await tx
    .select({
      planId: compPlans.id,
      rules: compPlans.commissionRules,
      baseSalaryCents: compPlans.baseSalaryCents,
      payPeriod: compPlans.payPeriod,
      assignmentFrom: userCompAssignments.effectiveFrom,
      assignmentTo: userCompAssignments.effectiveTo,
      planFrom: compPlans.effectiveFrom,
      planTo: compPlans.effectiveTo,
    })
    .from(userCompAssignments)
    .innerJoin(compPlans, eq(compPlans.id, userCompAssignments.compPlanId))
    .where(
      and(
        eq(userCompAssignments.userId, userId),
        lte(userCompAssignments.effectiveFrom, sql`${asOfDate}::date`),
        or(
          isNull(userCompAssignments.effectiveTo),
          gte(userCompAssignments.effectiveTo, sql`${asOfDate}::date`),
        ),
      ),
    )
    .orderBy(asc(userCompAssignments.effectiveFrom))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  let parsedRules: CommissionRule[] = [];
  if (Array.isArray(row.rules)) {
    parsedRules = row.rules.map(parseCommissionRule);
  }

  return {
    planId: row.planId,
    rules: parsedRules,
    baseSalaryCents: row.baseSalaryCents,
    payPeriod: row.payPeriod as 'monthly' | 'biweekly',
    effectiveFrom: new Date(row.assignmentFrom as unknown as string),
    effectiveTo: row.assignmentTo ? new Date(row.assignmentTo as unknown as string) : null,
  };
}

/**
 * Insert one ledger row idempotently. Returns true when the row was
 * inserted, false when ON CONFLICT prevented a duplicate.
 */
async function insertLedgerRow(tx: ScopedTx, row: LedgerInsert): Promise<boolean> {
  const result = await tx
    .insert(commissionLedger)
    .values({
      userId: row.userId,
      branchId: row.branchId,
      sourceKind: row.sourceKind,
      sourceId: row.sourceId,
      amountCents: row.amountCents,
      ruleSnapshot: row.ruleSnapshot,
      periodLabel: row.periodLabel,
    })
    .onConflictDoNothing({
      target: [commissionLedger.userId, commissionLedger.sourceKind, commissionLedger.sourceId],
    })
    .returning({ id: commissionLedger.id });
  return result.length > 0;
}

/**
 * Resolve the user to credit for an invoice. v1: the branch's current
 * manager (where ended_at IS NULL). Returns null if no active manager —
 * which is a misconfiguration the API surface should prevent, but the
 * engine fails closed (no credit, no error).
 */
async function findInvoiceCreditee(
  tx: ScopedTx,
  branchId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ userId: branchManagers.userId })
    .from(branchManagers)
    .where(
      and(eq(branchManagers.branchId, branchId), isNull(branchManagers.endedAt)),
    )
    .limit(1);
  return rows[0]?.userId ?? null;
}

/**
 * Fire when an invoice transitions to 'paid'. The caller (CHR-05 webhook
 * handler / job-completion path) passes the invoice id; this function
 * does everything else.
 */
export async function onInvoicePaid(
  tx: ScopedTx,
  invoiceId: string,
): Promise<LedgerInsert[]> {
  const invRows = await tx
    .select({
      id: invoices.id,
      branchId: invoices.branchId,
      total: invoices.total,
      paidAt: invoices.paidAt,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  const inv = invRows[0];
  if (!inv) return [];
  const paidAt = inv.paidAt ?? new Date();
  const amountCents = Math.round(Number(inv.total) * 100);
  if (amountCents <= 0) return [];

  const userId = await findInvoiceCreditee(tx, inv.branchId);
  if (!userId) return [];

  const plan = await findActivePlan(tx, userId, paidAt);
  if (!plan) return [];

  const period = periodLabelFor(paidAt);
  const expanded = expandRulesForInvoice(plan.rules, amountCents);
  const written: LedgerInsert[] = [];

  for (let i = 0; i < expanded.length; i += 1) {
    const item = expanded[i]!;
    // Multi-rule plans need distinct source_ids so each rule's row is
    // independently idempotent. Single-rule plans keep source_id = the
    // raw invoice id so a future second rule cannot collide.
    const sourceId =
      expanded.length === 1 ? inv.id : `${inv.id}:rule-${i}`;
    const row: LedgerInsert = {
      userId,
      branchId: inv.branchId,
      sourceKind: 'invoice_paid',
      sourceId,
      amountCents: item.amountCents,
      ruleSnapshot: { plan_id: plan.planId, rule: item.rule, invoice_total_cents: amountCents },
      periodLabel: period,
    };
    const inserted = await insertLedgerRow(tx, row);
    if (inserted) written.push(row);
  }
  return written;
}

/**
 * Fire when a supplier quote commits successfully. Credits the
 * `closerUserId` (the user who triggered commit) at their active comp
 * plan's `flat_percent_of_quote_committed` rate.
 *
 * Quote-side bookkeeping (quote/quote_line_items tables) lands in
 * SQB-01; until then this function compiles against the contract but
 * has no concrete schema to query. Callers (SQB-07) pass the
 * quote-side fields directly to avoid an extra query.
 */
export async function onQuoteCommitted(
  tx: ScopedTx,
  args: {
    quoteId: string;
    branchId: string;
    closerUserId: string;
    totalCents: number;
    committedAt: Date;
  },
): Promise<LedgerInsert[]> {
  if (args.totalCents <= 0) return [];

  const plan = await findActivePlan(tx, args.closerUserId, args.committedAt);
  if (!plan) return [];

  const period = periodLabelFor(args.committedAt);
  const expanded = expandRulesForQuote(plan.rules, args.totalCents);
  const written: LedgerInsert[] = [];

  for (let i = 0; i < expanded.length; i += 1) {
    const item = expanded[i]!;
    const sourceId =
      expanded.length === 1 ? args.quoteId : `${args.quoteId}:rule-${i}`;
    const row: LedgerInsert = {
      userId: args.closerUserId,
      branchId: args.branchId,
      sourceKind: 'quote_committed',
      sourceId,
      amountCents: item.amountCents,
      ruleSnapshot: { plan_id: plan.planId, rule: item.rule, quote_total_cents: args.totalCents },
      periodLabel: period,
    };
    const inserted = await insertLedgerRow(tx, row);
    if (inserted) written.push(row);
  }
  return written;
}

/**
 * Sum every ledger row written for `originalSourceKind:originalSourceId`
 * and emit a balancing manual_adjustment row that nets it to zero. Each
 * underlying ledger row produces one reversal so per-rule histories stay
 * traceable.
 */
async function writeReversals(
  tx: ScopedTx,
  originalSourceKind: Exclude<LedgerSourceKind, 'manual_adjustment'>,
  originalSourceId: string,
  reversalReason: string,
): Promise<LedgerInsert[]> {
  const originals = await tx
    .select({
      userId: commissionLedger.userId,
      branchId: commissionLedger.branchId,
      sourceId: commissionLedger.sourceId,
      amountCents: commissionLedger.amountCents,
      ruleSnapshot: commissionLedger.ruleSnapshot,
      periodLabel: commissionLedger.periodLabel,
    })
    .from(commissionLedger)
    .where(
      and(
        eq(commissionLedger.sourceKind, originalSourceKind),
        or(
          eq(commissionLedger.sourceId, originalSourceId),
          sql`${commissionLedger.sourceId} LIKE ${`${originalSourceId}:rule-%`}`,
        ),
      ),
    );

  const written: LedgerInsert[] = [];
  for (const o of originals) {
    const row: LedgerInsert = {
      userId: o.userId,
      branchId: o.branchId,
      sourceKind: 'manual_adjustment',
      sourceId: `reverse:${originalSourceKind}:${o.sourceId}`,
      amountCents: -o.amountCents,
      ruleSnapshot: {
        reason: reversalReason,
        reversed_source_kind: originalSourceKind,
        reversed_source_id: o.sourceId,
        original_rule_snapshot: o.ruleSnapshot,
      },
      // Reversal lands in the CURRENT period, not the original — payroll
      // claws back from the cycle in which the refund / void happens, so
      // accruals match cash.
      periodLabel: periodLabelFor(new Date()),
    };
    const inserted = await insertLedgerRow(tx, row);
    if (inserted) written.push(row);
  }
  return written;
}

export async function reverseInvoicePaid(
  tx: ScopedTx,
  invoiceId: string,
  reason = 'invoice_refunded',
): Promise<LedgerInsert[]> {
  return writeReversals(tx, 'invoice_paid', invoiceId, reason);
}

export async function reverseQuoteCommitted(
  tx: ScopedTx,
  quoteId: string,
  reason = 'quote_voided',
): Promise<LedgerInsert[]> {
  return writeReversals(tx, 'quote_committed', quoteId, reason);
}

/**
 * Statement-ready aggregate for one user, one period. Base salary +
 * commission_ledger sum (which includes negative reversals).
 */
export async function computeCommission(
  tx: ScopedTx,
  userId: string,
  periodLabel: string,
): Promise<CommissionResult> {
  const rows = await tx
    .select({
      sourceKind: commissionLedger.sourceKind,
      sourceId: commissionLedger.sourceId,
      amountCents: commissionLedger.amountCents,
      ruleSnapshot: commissionLedger.ruleSnapshot,
    })
    .from(commissionLedger)
    .where(
      and(
        eq(commissionLedger.userId, userId),
        eq(commissionLedger.periodLabel, periodLabel),
      ),
    )
    .orderBy(asc(commissionLedger.createdAt));

  const lineItems: CommissionLineItem[] = rows.map((r) => ({
    sourceKind: r.sourceKind as LedgerSourceKind,
    sourceId: r.sourceId,
    amountCents: r.amountCents,
    ruleSnapshot: (r.ruleSnapshot ?? {}) as Record<string, unknown>,
  }));

  const commissionCents = lineItems.reduce((sum, li) => sum + li.amountCents, 0);

  // Base salary requires the user's active plan during the period. Use
  // the FIRST day of the period as the lookup date — picks up whichever
  // plan was in force at the start. Mid-period plan changes are
  // commission-only for v1 (acceptable per gate).
  const [yStr, mStr] = periodLabel.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  let baseSalaryCents = 0;
  if (Number.isFinite(y) && Number.isFinite(m)) {
    const startOfPeriod = new Date(Date.UTC(y, m - 1, 1));
    const plan = await findActivePlan(tx, userId, startOfPeriod);
    if (plan) {
      baseSalaryCents = prorateBaseSalary({
        baseSalaryCents: plan.baseSalaryCents,
        payPeriod: plan.payPeriod,
        periodLabel,
        effectiveFrom: plan.effectiveFrom,
        effectiveTo: plan.effectiveTo,
      });
    }
  }

  return {
    period: periodLabel,
    baseSalaryCents,
    commissionCents,
    totalCents: baseSalaryCents + commissionCents,
    lineItems,
  };
}
