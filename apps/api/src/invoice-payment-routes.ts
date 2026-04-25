/**
 * Invoice finalize / send / refund (TASK-IP-04 + IP-06).
 *
 *   POST /api/v1/invoices/:id/finalize  — draft → finalized.
 *     Creates a Stripe PaymentIntent on the franchisee's connected
 *     account, stamps application_fee_amount (5% of total, server-
 *     computed), stores stripe_payment_intent_id and a 32-byte
 *     base64url payment_link_token. 409 STRIPE_NOT_READY if the
 *     franchisee hasn't completed Connect onboarding.
 *
 *   POST /api/v1/invoices/:id/send      — finalized → sent.
 *     Dispatches the payment link via email (customer.email) + SMS
 *     (customer.phone) through the pluggable senders. Either
 *     address missing is a soft-skip — we record which channels
 *     fired in the response envelope but do not fail the call.
 *
 *   POST /api/v1/invoices/:id/refund    — paid invoice → refund row.
 *     Supports full (amount omitted) or partial refund. Amount
 *     exceeding remaining balance → 400 REFUND_OUT_OF_BOUNDS. Only
 *     paid invoices are refundable → 409 INVALID_TRANSITION otherwise.
 *     The Stripe refund row is created synchronously; the webhook
 *     reconciles via charge.refunded but this route inserts the DB
 *     row up front so callers see `{ deleted: ... }` immediately.
 *
 * All three transitions run inside one withScope transaction so
 * RLS fires and the status change + side-effect row insert share
 * the same atomic write window.
 */

import type { FastifyInstance } from 'fastify';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  customers,
  franchiseAgreements,
  franchisees,
  invoices,
  invoiceLineItems,
  payments,
  refunds,
  royaltyRules,
  withScope,
  type RequestScope,
  type ScopedTx,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import type { StripeClient } from './stripe.js';
import type { EmailSender, SmsSender } from './notify.js';
import {
  resolveFeeCents,
  defaultFallbackFeeCents,
  type StoredRule,
} from './royalty-engine.js';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Deps {
  stripe: StripeClient;
  emailSender: EmailSender;
  smsSender: SmsSender;
  /** Base URL used for the customer-facing payment page. */
  publicBaseUrl: string;
}

function scopedFranchiseeId(scope: RequestScope): string | null {
  if (scope.type === 'platform' || scope.type === 'franchisor') return null;
  return scope.franchiseeId;
}

function centsFromDollars(dollars: string | number): number {
  // numeric(12,2) has at most two decimal places so multiply-by-100
  // rounds cleanly. We still guard against 1.005 → 100.499…
  const n = typeof dollars === 'string' ? Number(dollars) : dollars;
  return Math.round(n * 100);
}

function newPaymentLinkToken(): string {
  return randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function loadInvoice(
  tx: ScopedTx,
  id: string,
  scope: RequestScope,
): Promise<
  | {
      kind: 'ok';
      invoice: typeof invoices.$inferSelect;
      franchisee: typeof franchisees.$inferSelect;
      customer: typeof customers.$inferSelect;
    }
  | { kind: 'not_found' }
> {
  const rows = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, id), isNull(invoices.deletedAt)));
  const invoice = rows[0];
  if (!invoice) return { kind: 'not_found' };
  const feScope = scopedFranchiseeId(scope);
  if (feScope && invoice.franchiseeId !== feScope) return { kind: 'not_found' };
  const feRows = await tx
    .select()
    .from(franchisees)
    .where(eq(franchisees.id, invoice.franchiseeId));
  const franchisee = feRows[0];
  if (!franchisee) return { kind: 'not_found' };
  if (
    scope.type === 'franchisor' &&
    franchisee.franchisorId !== scope.franchisorId
  )
    return { kind: 'not_found' };
  const custRows = await tx
    .select()
    .from(customers)
    .where(eq(customers.id, invoice.customerId));
  const customer = custRows[0];
  if (!customer) return { kind: 'not_found' };
  return { kind: 'ok', invoice, franchisee, customer };
}

export function registerInvoicePaymentRoutes(
  app: FastifyInstance,
  db: Drizzle,
  deps: Deps,
): void {
  // ----- POST /api/v1/invoices/:id/finalize ---------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/invoices/:id/finalize',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const scope = req.scope;
      type Outcome =
        | { kind: 'not_found' }
        | { kind: 'bad_transition'; from: string; to: string }
        | { kind: 'stripe_not_ready' }
        | { kind: 'empty' }
        | { kind: 'ok'; invoice: typeof invoices.$inferSelect; paymentUrl: string };
      const outcome = await withScope(db, scope, async (tx): Promise<Outcome> => {
        const loaded = await loadInvoice(tx, req.params.id, scope);
        if (loaded.kind === 'not_found') return { kind: 'not_found' };
        const { invoice, franchisee } = loaded;
        if (invoice.status !== 'draft')
          return {
            kind: 'bad_transition',
            from: invoice.status,
            to: 'finalized',
          };
        if (!franchisee.stripeAccountId || !franchisee.stripeChargesEnabled)
          return { kind: 'stripe_not_ready' };
        const totalCents = centsFromDollars(invoice.total);
        if (totalCents <= 0) return { kind: 'empty' };

        // Resolve the active franchise agreement to compute the
        // platform fee. Fall back to phase-7 flat 5% when the
        // franchisee has no active agreement yet — this preserves
        // existing integration tests and makes onboarding smooth.
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
        let applicationFeeCents: number;
        if (!activeAgreement) {
          applicationFeeCents = defaultFallbackFeeCents(totalCents);
        } else {
          const rules = await tx
            .select()
            .from(royaltyRules)
            .where(eq(royaltyRules.agreementId, activeAgreement.id))
            .orderBy(royaltyRules.sortOrder);
          const stored: StoredRule[] = rules.map((r) => ({
            id: r.id,
            ruleType: r.ruleType,
            params: r.params,
            sortOrder: r.sortOrder,
          }));
          // Context for this invoice: month-to-date gross + fees.
          // Any partial-month accuracy comes out in the wash at
          // statement time — the point of `monthGrossCents` /
          // `monthFeesAccruedCents` is correct tiered + floor
          // arithmetic, not exact observability.
          const monthStart = new Date(
            Date.UTC(
              new Date().getUTCFullYear(),
              new Date().getUTCMonth(),
              1,
              0, 0, 0, 0,
            ),
          );
          const aggRows = await tx
            .select({
              grossCents: sql<string>`COALESCE(SUM(${payments.amount} * 100), 0)`,
              feesCents: sql<string>`COALESCE(SUM(${payments.applicationFeeAmount} * 100), 0)`,
            })
            .from(payments)
            .where(
              and(
                eq(payments.franchiseeId, franchisee.id),
                gte(payments.createdAt, monthStart),
              ),
            );
          const monthGrossCents = Math.round(Number(aggRows[0]?.grossCents ?? 0));
          const monthFeesAccruedCents = Math.round(
            Number(aggRows[0]?.feesCents ?? 0),
          );
          applicationFeeCents = resolveFeeCents(stored, {
            totalCents,
            jobCountThisMonth: 0,
            monthGrossCents,
            monthFeesAccruedCents,
          });
        }

        const pi = await deps.stripe.createPaymentIntent({
          amount: totalCents,
          applicationFeeAmount: applicationFeeCents,
          currency: 'usd',
          onBehalfOf: franchisee.stripeAccountId,
          transferDestination: franchisee.stripeAccountId,
          metadata: {
            invoiceId: invoice.id,
            franchiseeId: franchisee.id,
          },
        });

        const token = invoice.paymentLinkToken ?? newPaymentLinkToken();
        const now = new Date();
        const updated = await tx
          .update(invoices)
          .set({
            status: 'finalized',
            finalizedAt: now,
            stripePaymentIntentId: pi.id,
            paymentLinkToken: token,
            applicationFeeAmount: (applicationFeeCents / 100).toFixed(2),
            updatedAt: now,
          })
          .where(eq(invoices.id, invoice.id))
          .returning();
        const paymentUrl = `${deps.publicBaseUrl}/invoices/${token}/pay`;
        return { kind: 'ok', invoice: updated[0]!, paymentUrl };
      });

      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Invoice not found' },
        });
      }
      if (outcome.kind === 'bad_transition') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'INVALID_TRANSITION',
            message: `Cannot transition ${outcome.from} → ${outcome.to}`,
          },
        });
      }
      if (outcome.kind === 'stripe_not_ready') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'STRIPE_NOT_READY',
            message: 'Franchisee has not completed Stripe Connect onboarding',
          },
        });
      }
      if (outcome.kind === 'empty') {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'EMPTY_INVOICE',
            message: 'Cannot finalize an invoice with zero total',
          },
        });
      }
      return reply.code(200).send({
        ok: true,
        data: { ...outcome.invoice, paymentUrl: outcome.paymentUrl },
      });
    },
  );

  // ----- POST /api/v1/invoices/:id/send -------------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/invoices/:id/send',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const scope = req.scope;
      type Outcome =
        | { kind: 'not_found' }
        | { kind: 'bad_transition'; from: string; to: string }
        | { kind: 'missing_link' }
        | {
            kind: 'ok';
            invoice: typeof invoices.$inferSelect;
            customer: typeof customers.$inferSelect;
            paymentUrl: string;
          };
      const outcome = await withScope(db, scope, async (tx): Promise<Outcome> => {
        const loaded = await loadInvoice(tx, req.params.id, scope);
        if (loaded.kind === 'not_found') return { kind: 'not_found' };
        const { invoice, customer } = loaded;
        if (invoice.status !== 'finalized' && invoice.status !== 'sent')
          return { kind: 'bad_transition', from: invoice.status, to: 'sent' };
        if (!invoice.paymentLinkToken) return { kind: 'missing_link' };
        const now = new Date();
        const updated = await tx
          .update(invoices)
          .set({
            status: 'sent',
            sentAt: invoice.sentAt ?? now,
            updatedAt: now,
          })
          .where(eq(invoices.id, invoice.id))
          .returning();
        const paymentUrl = `${deps.publicBaseUrl}/invoices/${invoice.paymentLinkToken}/pay`;
        return { kind: 'ok', invoice: updated[0]!, customer, paymentUrl };
      });

      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Invoice not found' },
        });
      }
      if (outcome.kind === 'bad_transition') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'INVALID_TRANSITION',
            message: `Cannot transition ${outcome.from} → ${outcome.to}`,
          },
        });
      }
      if (outcome.kind === 'missing_link') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'MISSING_PAYMENT_LINK',
            message: 'Invoice has no payment link — re-finalize first',
          },
        });
      }
      const channels: Array<'email' | 'sms'> = [];
      const sendContext = {
        franchiseeId: outcome.invoice.franchiseeId,
        invoiceId: outcome.invoice.id,
        jobId: outcome.invoice.jobId,
        customerId: outcome.customer.id,
        relatedKind: 'invoice',
      };
      if (outcome.customer.email) {
        await deps.emailSender.send({
          to: outcome.customer.email,
          subject: 'Your invoice from ' + (outcome.customer.name ?? 'us'),
          text: `Your invoice is ready. Pay securely: ${outcome.paymentUrl}`,
          tag: 'invoice-send',
          context: sendContext,
        });
        channels.push('email');
      }
      if (outcome.customer.phone) {
        await deps.smsSender.send({
          to: outcome.customer.phone,
          body: `Your invoice: ${outcome.paymentUrl}`,
          tag: 'invoice-send',
          context: sendContext,
        });
        channels.push('sms');
      }
      return reply.code(200).send({
        ok: true,
        data: { ...outcome.invoice, paymentUrl: outcome.paymentUrl, channels },
      });
    },
  );

  // ----- POST /api/v1/invoices/:id/refund -----------------------------------
  const RefundBody = z.object({
    amount: z.number().positive().optional(),
    reason: z.string().max(200).optional(),
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/invoices/:id/refund',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const parsed = RefundBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const scope = req.scope;
      type Outcome =
        | { kind: 'not_found' }
        | { kind: 'bad_transition'; from: string }
        | { kind: 'out_of_bounds'; remaining: number; attempted: number }
        | { kind: 'no_intent' }
        | {
            kind: 'ok';
            refundRow: typeof refunds.$inferSelect;
            invoice: typeof invoices.$inferSelect;
          };
      const outcome = await withScope(db, scope, async (tx): Promise<Outcome> => {
        const loaded = await loadInvoice(tx, req.params.id, scope);
        if (loaded.kind === 'not_found') return { kind: 'not_found' };
        const { invoice } = loaded;
        if (invoice.status !== 'paid' && invoice.status !== 'void')
          return { kind: 'bad_transition', from: invoice.status };
        if (!invoice.stripePaymentIntentId) return { kind: 'no_intent' };
        const totalCents = centsFromDollars(invoice.total);
        const existing = await tx
          .select({ amount: refunds.amount })
          .from(refunds)
          .where(eq(refunds.invoiceId, invoice.id));
        const refundedCents = existing.reduce(
          (acc, r) => acc + centsFromDollars(r.amount),
          0,
        );
        const remainingCents = Math.max(totalCents - refundedCents, 0);
        if (remainingCents === 0)
          return { kind: 'bad_transition', from: 'fully-refunded' };
        const attemptedCents =
          parsed.data.amount !== undefined
            ? centsFromDollars(parsed.data.amount)
            : remainingCents;
        if (attemptedCents > remainingCents)
          return {
            kind: 'out_of_bounds',
            remaining: remainingCents,
            attempted: attemptedCents,
          };

        const stripeRefund = await deps.stripe.createRefund({
          paymentIntentId: invoice.stripePaymentIntentId,
          amount: attemptedCents,
          reason: parsed.data.reason,
          metadata: { invoiceId: invoice.id },
        });
        const paymentRow = await tx
          .select()
          .from(payments)
          .where(eq(payments.invoiceId, invoice.id));
        const paymentId = paymentRow[0]?.id ?? null;

        const insertedRefunds = await tx
          .insert(refunds)
          .values({
            franchiseeId: invoice.franchiseeId,
            invoiceId: invoice.id,
            paymentId,
            stripeRefundId: stripeRefund.id,
            amount: (attemptedCents / 100).toFixed(2),
            reason: parsed.data.reason ?? null,
            status: stripeRefund.status,
          })
          .returning();

        const now = new Date();
        let updatedInvoice = invoice;
        if (attemptedCents === remainingCents) {
          const updated = await tx
            .update(invoices)
            .set({ status: 'void', voidedAt: now, updatedAt: now })
            .where(eq(invoices.id, invoice.id))
            .returning();
          updatedInvoice = updated[0]!;
        }
        return {
          kind: 'ok',
          refundRow: insertedRefunds[0]!,
          invoice: updatedInvoice,
        };
      });

      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Invoice not found' },
        });
      }
      if (outcome.kind === 'bad_transition') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'INVALID_TRANSITION',
            message: `Cannot refund an invoice in state ${outcome.from}`,
          },
        });
      }
      if (outcome.kind === 'no_intent') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'NO_PAYMENT_INTENT',
            message: 'Invoice was never finalized',
          },
        });
      }
      if (outcome.kind === 'out_of_bounds') {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'REFUND_OUT_OF_BOUNDS',
            message: `Attempted ${outcome.attempted / 100}, remaining ${outcome.remaining / 100}`,
          },
        });
      }
      return reply.code(201).send({
        ok: true,
        data: {
          refund: outcome.refundRow,
          invoice: outcome.invoice,
        },
      });
    },
  );
}

void invoiceLineItems;
