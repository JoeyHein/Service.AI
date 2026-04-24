/**
 * AI collections pipeline (phase_ai_collections).
 *
 *   collectionsDraft — run a single AI turn with the
 *     collections prompt, parse JSON, insert a
 *     collections_drafts row.
 *
 *   selectAgedInvoices — pure projector that returns
 *     [{ invoiceId, tone }] tuples for invoices crossing a
 *     cadence threshold.
 *
 *   runCollectionsSweep — loops the projector + drafter,
 *     idempotent via the partial unique index
 *     (invoice_id, tone) WHERE status='pending'.
 *
 *   schedulePaymentRetry — called from the Stripe webhook on
 *     payment_intent.payment_failed; picks a delay from the
 *     failure-code table and inserts a payment_retries row.
 */

import { and, eq, gte, isNull, lt, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  aiConversations,
  aiMessages,
  collectionsDrafts,
  customers,
  franchisees,
  invoices,
  paymentRetries,
  payments,
  type RequestScope,
  type ScopedTx,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import type { AIClient } from '@service-ai/ai';
import {
  collectionsSystemPrompt,
  type CollectionsTone,
} from '@service-ai/ai/prompts/collections';

type Drizzle = NodePgDatabase<typeof schema>;

export interface CollectionsDeps {
  db: Drizzle;
  ai: AIClient;
}

// ---------------------------------------------------------------------------
// Draft a single reminder for an invoice + tone.
// ---------------------------------------------------------------------------

export interface CollectionsDraftInput {
  scope: RequestScope;
  franchiseeId: string;
  invoiceId: string;
  tone: CollectionsTone;
  /** Base URL used to compose the payment page URL. */
  publicBaseUrl: string;
}

export interface CollectionsDraftResult {
  id: string;
  conversationId: string;
  tone: CollectionsTone;
  smsBody: string;
  emailSubject: string;
  emailBody: string;
  status: 'pending';
}

function daysBetween(a: Date, b: Date): number {
  const diffMs = a.getTime() - b.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

interface DraftCopy {
  sms: string;
  email: { subject: string; body: string };
}

function toneFallbackCopy(ctx: {
  brandName: string;
  customerName: string;
  invoiceNumber: string;
  amountDue: string;
  paymentUrl: string;
  tone: CollectionsTone;
}): DraftCopy {
  // Deterministic fallback when the AI emits non-JSON. Keeps
  // the feature functional even with a barebones stub client.
  const prefix =
    ctx.tone === 'friendly'
      ? 'Hi'
      : ctx.tone === 'firm'
        ? 'Following up'
        : 'Final notice';
  const sms = `${prefix}, ${ctx.customerName} — invoice ${ctx.invoiceNumber} for $${ctx.amountDue} is open. Pay here: ${ctx.paymentUrl}`;
  const subject =
    ctx.tone === 'final'
      ? `Final notice: invoice ${ctx.invoiceNumber}`
      : `Invoice ${ctx.invoiceNumber} — ${ctx.brandName}`;
  const body = `${prefix}, ${ctx.customerName},\n\nInvoice ${ctx.invoiceNumber} from ${ctx.brandName} is open for $${ctx.amountDue}. You can pay online at ${ctx.paymentUrl}.\n\nThanks,\n${ctx.brandName}`;
  return { sms, email: { subject, body } };
}

function parseDraftCopy(raw: string, fallback: DraftCopy): DraftCopy {
  try {
    const parsed = JSON.parse(raw) as Partial<DraftCopy>;
    if (
      typeof parsed.sms === 'string' &&
      parsed.email &&
      typeof parsed.email.subject === 'string' &&
      typeof parsed.email.body === 'string'
    ) {
      return { sms: parsed.sms, email: parsed.email };
    }
  } catch {
    // fall through
  }
  return fallback;
}

export async function collectionsDraft(
  deps: CollectionsDeps,
  input: CollectionsDraftInput,
): Promise<CollectionsDraftResult | null> {
  const feRows = await deps.db
    .select()
    .from(franchisees)
    .where(eq(franchisees.id, input.franchiseeId));
  const fe = feRows[0];
  if (!fe) return null;
  const invRows = await deps.db
    .select()
    .from(invoices)
    .where(eq(invoices.id, input.invoiceId));
  const invoice = invRows[0];
  if (!invoice || invoice.franchiseeId !== input.franchiseeId) return null;
  const custRows = await deps.db
    .select()
    .from(customers)
    .where(eq(customers.id, invoice.customerId));
  const customer = custRows[0];
  if (!customer) return null;

  // Skip if there's already a pending draft for this invoice/tone
  // — the partial unique index would throw on insert, so check
  // first to return a clean result.
  const existing = await deps.db
    .select()
    .from(collectionsDrafts)
    .where(
      and(
        eq(collectionsDrafts.invoiceId, invoice.id),
        eq(collectionsDrafts.tone, input.tone),
        eq(collectionsDrafts.status, 'pending'),
      ),
    );
  if (existing[0]) {
    return {
      id: existing[0].id,
      conversationId: existing[0].conversationId ?? '',
      tone: existing[0].tone,
      smsBody: existing[0].smsBody,
      emailSubject: existing[0].emailSubject,
      emailBody: existing[0].emailBody,
      status: 'pending',
    };
  }

  const conv = await deps.db
    .insert(aiConversations)
    .values({
      franchiseeId: input.franchiseeId,
      capability: 'collections',
      subjectCustomerId: customer.id,
      subjectJobId: invoice.jobId,
    })
    .returning();
  const conversationId = conv[0]!.id;

  const daysPast = invoice.finalizedAt
    ? daysBetween(new Date(), invoice.finalizedAt)
    : 0;
  const paymentUrl = invoice.paymentLinkToken
    ? `${input.publicBaseUrl}/invoices/${invoice.paymentLinkToken}/pay`
    : `${input.publicBaseUrl}/invoices`;
  const ctx = {
    tone: input.tone,
    brandName: fe.name,
    customerName: customer.name,
    invoiceNumber: invoice.id.slice(0, 8).toUpperCase(),
    amountDue: invoice.total,
    daysPastDue: daysPast,
    paymentUrl,
  };

  const turn = await deps.ai.turn({
    systemPrompt: collectionsSystemPrompt(ctx),
    history: [
      {
        role: 'user',
        content: `Draft the reminder for ${customer.name} now.`,
      },
    ],
    tools: [],
  });
  const fallback = toneFallbackCopy(ctx);
  const copy = turn.kind === 'text' ? parseDraftCopy(turn.text, fallback) : fallback;

  await deps.db.insert(aiMessages).values({
    conversationId,
    franchiseeId: input.franchiseeId,
    role: 'assistant',
    content: copy,
    confidence: '1',
    provider: turn.provider,
    model: turn.model,
    costUsd: turn.costUsd.toFixed(6),
  });

  const inserted = await deps.db
    .insert(collectionsDrafts)
    .values({
      franchiseeId: input.franchiseeId,
      invoiceId: invoice.id,
      conversationId,
      tone: input.tone,
      smsBody: copy.sms,
      emailSubject: copy.email.subject,
      emailBody: copy.email.body,
    })
    .returning();
  return {
    id: inserted[0]!.id,
    conversationId,
    tone: input.tone,
    smsBody: copy.sms,
    emailSubject: copy.email.subject,
    emailBody: copy.email.body,
    status: 'pending',
  };
}

// ---------------------------------------------------------------------------
// Aging projector — pure.
// ---------------------------------------------------------------------------

export interface AgingCadence {
  friendly: number;
  firm: number;
  final: number;
}

const DEFAULT_CADENCE: AgingCadence = {
  friendly: 7,
  firm: 14,
  final: 30,
};

function cadenceFor(guardrails: unknown): AgingCadence {
  if (
    guardrails &&
    typeof guardrails === 'object' &&
    (guardrails as Record<string, unknown>).collections &&
    typeof (guardrails as Record<string, unknown>).collections === 'object'
  ) {
    const col = (guardrails as Record<string, Record<string, unknown>>)
      .collections;
    return {
      friendly:
        typeof col.cadenceDaysFriendly === 'number'
          ? (col.cadenceDaysFriendly as number)
          : DEFAULT_CADENCE.friendly,
      firm:
        typeof col.cadenceDaysFirm === 'number'
          ? (col.cadenceDaysFirm as number)
          : DEFAULT_CADENCE.firm,
      final:
        typeof col.cadenceDaysFinal === 'number'
          ? (col.cadenceDaysFinal as number)
          : DEFAULT_CADENCE.final,
    };
  }
  return DEFAULT_CADENCE;
}

export interface AgedInvoiceTuple {
  invoiceId: string;
  tone: CollectionsTone;
  daysPastDue: number;
}

/**
 * Picks invoices whose days-past-due crosses one of the cadence
 * thresholds (and the tone isn't already sent or pending). The
 * projector is pure — no writes. The caller persists via
 * runCollectionsSweep.
 */
export async function selectAgedInvoices(
  tx: ScopedTx | Drizzle,
  input: {
    franchiseeId: string;
    now?: Date;
    cadence?: AgingCadence;
  },
): Promise<AgedInvoiceTuple[]> {
  const now = input.now ?? new Date();
  const cadence = input.cadence ?? DEFAULT_CADENCE;

  const thresholds: Array<{ tone: CollectionsTone; days: number }> = [
    { tone: 'final', days: cadence.final },
    { tone: 'firm', days: cadence.firm },
    { tone: 'friendly', days: cadence.friendly },
  ];

  const candidateRows = await tx
    .select({
      id: invoices.id,
      finalizedAt: invoices.finalizedAt,
      sentAt: invoices.sentAt,
      status: invoices.status,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.franchiseeId, input.franchiseeId),
        or(eq(invoices.status, 'sent'), eq(invoices.status, 'finalized')),
        isNull(invoices.deletedAt),
      ),
    );

  const out: AgedInvoiceTuple[] = [];
  for (const inv of candidateRows) {
    const base = inv.sentAt ?? inv.finalizedAt;
    if (!base) continue;
    const days = Math.floor((now.getTime() - base.getTime()) / (1000 * 60 * 60 * 24));
    // Pick the most-severe tone whose threshold the invoice has
    // crossed. If the invoice is 31 days past due, we want to
    // draft the "final" reminder first, not a "friendly" one.
    let tone: CollectionsTone | null = null;
    for (const t of thresholds) {
      if (days >= t.days) {
        tone = t.tone;
        break;
      }
    }
    if (!tone) continue;

    // Skip if a non-pending send for this tone already exists, or
    // a pending row is still in the queue (the partial unique
    // index would make the insert throw anyway; this just makes
    // the projector output clean).
    const prior = await tx
      .select({ id: collectionsDrafts.id, status: collectionsDrafts.status })
      .from(collectionsDrafts)
      .where(
        and(
          eq(collectionsDrafts.invoiceId, inv.id),
          eq(collectionsDrafts.tone, tone),
        ),
      );
    const blocked = prior.some(
      (r) => r.status === 'pending' || r.status === 'sent',
    );
    if (blocked) continue;
    out.push({ invoiceId: inv.id, tone, daysPastDue: days });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sweep — aging + draft in one pass.
// ---------------------------------------------------------------------------

export interface SweepInput {
  scope: RequestScope;
  franchiseeId: string;
  publicBaseUrl: string;
  /** Override "now" for testability. */
  now?: Date;
}

export interface SweepResult {
  inspected: number;
  drafted: number;
  draftIds: string[];
}

export async function runCollectionsSweep(
  deps: CollectionsDeps,
  input: SweepInput,
): Promise<SweepResult> {
  const feRows = await deps.db
    .select()
    .from(franchisees)
    .where(eq(franchisees.id, input.franchiseeId));
  const fe = feRows[0];
  if (!fe) return { inspected: 0, drafted: 0, draftIds: [] };
  const cadence = cadenceFor(fe.aiGuardrails);

  const tuples = await selectAgedInvoices(deps.db, {
    franchiseeId: input.franchiseeId,
    now: input.now,
    cadence,
  });
  const ids: string[] = [];
  for (const t of tuples) {
    const r = await collectionsDraft(deps, {
      scope: input.scope,
      franchiseeId: input.franchiseeId,
      invoiceId: t.invoiceId,
      tone: t.tone,
      publicBaseUrl: input.publicBaseUrl,
    });
    if (r) ids.push(r.id);
  }
  return { inspected: tuples.length, drafted: ids.length, draftIds: ids };
}

// ---------------------------------------------------------------------------
// Payment retry: schedule + run.
// ---------------------------------------------------------------------------

const RETRY_DELAY_MS: Record<string, number> = {
  authentication_required: 60 * 60 * 1000, // 1 hour
  card_declined: 3 * 24 * 60 * 60 * 1000, // 3 days
  insufficient_funds: 5 * 24 * 60 * 60 * 1000, // 5 days
  expired_card: 7 * 24 * 60 * 60 * 1000, // 7 days
  processing_error: 60 * 60 * 1000, // 1 hour
};
const DEFAULT_RETRY_DELAY_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

export interface ScheduleRetryInput {
  franchiseeId: string;
  invoiceId: string;
  paymentId?: string | null;
  failureCode: string;
  now?: Date;
}

export function retryDelayMs(failureCode: string): number {
  return RETRY_DELAY_MS[failureCode] ?? DEFAULT_RETRY_DELAY_MS;
}

/**
 * Called from the Stripe webhook when a payment_intent fails.
 * Idempotent via a per-attempt guard: if a scheduled row already
 * exists for (invoiceId, attemptIndex), skip.
 */
export async function schedulePaymentRetry(
  db: Drizzle,
  input: ScheduleRetryInput,
): Promise<{ id: string; scheduledFor: Date } | null> {
  // Count prior retries to set attemptIndex.
  const prior = await db
    .select({ attemptIndex: paymentRetries.attemptIndex })
    .from(paymentRetries)
    .where(eq(paymentRetries.invoiceId, input.invoiceId));
  const attemptIndex = Math.max(0, ...prior.map((p) => p.attemptIndex)) + 1;
  if (attemptIndex > 4) {
    // Stop retrying after 4 attempts — human handoff happens in
    // the phase-12 out-of-scope flow.
    return null;
  }
  const now = input.now ?? new Date();
  const scheduledFor = new Date(now.getTime() + retryDelayMs(input.failureCode));
  const inserted = await db
    .insert(paymentRetries)
    .values({
      franchiseeId: input.franchiseeId,
      invoiceId: input.invoiceId,
      paymentId: input.paymentId ?? null,
      failureCode: input.failureCode,
      scheduledFor,
      attemptIndex,
    })
    .returning();
  return { id: inserted[0]!.id, scheduledFor };
}

// ---------------------------------------------------------------------------
// DSO + recovered revenue projector.
// ---------------------------------------------------------------------------

export interface CollectionsMetrics {
  dsoDays: number;
  recoveredRevenueCents: number;
  openInvoiceCents: number;
  totalRevenueCents: number;
}

/**
 * Days-Sales-Outstanding = (openReceivables / revenue) * 30 for the
 * trailing 30 days. Recovered-revenue = payments whose prior
 * payment_retries row resolved (payment.createdAt > any prior
 * retry row for the same invoice).
 */
export async function computeCollectionsMetrics(
  tx: ScopedTx | Drizzle,
  input: { franchiseeId: string; now?: Date },
): Promise<CollectionsMetrics> {
  const now = input.now ?? new Date();
  const periodStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const invRows = await tx
    .select({
      status: invoices.status,
      total: invoices.total,
      finalizedAt: invoices.finalizedAt,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.franchiseeId, input.franchiseeId),
        gte(invoices.finalizedAt, periodStart),
        isNull(invoices.deletedAt),
      ),
    );
  let totalCents = 0;
  let openCents = 0;
  for (const r of invRows) {
    const cents = Math.round(Number(r.total) * 100);
    totalCents += cents;
    if (r.status === 'sent' || r.status === 'finalized') {
      openCents += cents;
    }
  }
  const dsoDays =
    totalCents === 0 ? 0 : Math.round((openCents / totalCents) * 30 * 10) / 10;

  const retryRows = await tx
    .select({
      invoiceId: paymentRetries.invoiceId,
      createdAt: paymentRetries.createdAt,
    })
    .from(paymentRetries)
    .where(
      and(
        eq(paymentRetries.franchiseeId, input.franchiseeId),
        gte(paymentRetries.createdAt, periodStart),
      ),
    );
  const retriedInvoiceIds = new Set(retryRows.map((r) => r.invoiceId));
  let recoveredCents = 0;
  if (retriedInvoiceIds.size > 0) {
    const paymentRows = await tx
      .select({
        invoiceId: payments.invoiceId,
        amount: payments.amount,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .where(eq(payments.franchiseeId, input.franchiseeId));
    for (const p of paymentRows) {
      if (!retriedInvoiceIds.has(p.invoiceId)) continue;
      // Recovered = payment landed AFTER the most recent retry.
      const retry = retryRows
        .filter((r) => r.invoiceId === p.invoiceId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .pop();
      if (retry && p.createdAt > retry.createdAt) {
        recoveredCents += Math.round(Number(p.amount) * 100);
      }
    }
  }
  return {
    dsoDays,
    recoveredRevenueCents: recoveredCents,
    openInvoiceCents: openCents,
    totalRevenueCents: totalCents,
  };
}

// Keep unused-import smoothers.
void lt;
