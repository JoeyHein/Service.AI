/**
 * Stripe webhook handler (TASK-IP-05).
 *
 *   POST /api/v1/webhooks/stripe
 *
 * The route is deliberately OUTSIDE RequestScope — Stripe is an
 * untrusted caller, so there is no session cookie or JWT to
 * resolve tenant context from. The handler:
 *
 *   1. Pulls the raw body via the Fastify addContentTypeParser
 *      hook we register here (`application/json` → keep as a
 *      Buffer instead of parsing).
 *   2. Verifies the signature via `StripeClient.constructWebhookEvent`.
 *      Bad signature → 400, no DB work, no side effects.
 *   3. Inserts the event id into `stripe_events` first. On unique
 *      violation the handler short-circuits to 200 (replay).
 *   4. Dispatches per event type.
 *
 * Lookups run on the raw Drizzle handle; the row writes that follow
 * run inside a `withScope` transaction stamped with the synthetic
 * `corporate_admin` scope (CHR-08), so the commission engine's
 * scoped queries succeed when production RLS is active. Every row we
 * write is keyed on a Stripe id so replay + concurrent delivery is
 * idempotent.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  invoices,
  payments,
  quotes,
  refunds,
  stripeEvents,
  withScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import { logger } from './logger.js';
import type { StripeClient } from './stripe.js';
import { onInvoicePaid, reverseInvoicePaid } from './commission-engine.js';

type Drizzle = NodePgDatabase<typeof schema>;

interface PaymentIntentLike {
  id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  latest_charge?: string | null;
  charges?: { data?: Array<{ id: string }> };
  metadata?: { invoiceId?: string; branchId?: string };
}

interface ChargeLike {
  id?: string;
  payment_intent?: string | null;
  amount_refunded?: number;
  refunds?: {
    data?: Array<{
      id: string;
      amount: number;
      reason?: string | null;
      status?: string | null;
    }>;
  };
}

async function insertEventIdempotent(
  db: Drizzle,
  eventId: string,
  type: string,
): Promise<boolean> {
  // ON CONFLICT DO NOTHING returns the inserted row when fresh and
  // an empty array on replay — much more reliable than catching
  // unique-violation error text across drivers / locales.
  const rows = await db
    .insert(stripeEvents)
    .values({ id: eventId, type })
    .onConflictDoNothing({ target: stripeEvents.id })
    .returning({ id: stripeEvents.id });
  return rows.length === 1;
}

/**
 * Synthetic corporate scope used by the webhook handler so the commission
 * engine's RLS-scoped queries succeed. The webhook is an untrusted caller
 * with no session, but every event we process is a corporate-side action
 * (invoice paid/refunded) so corporate_admin is the correct role.
 */
const WEBHOOK_SCOPE = {
  type: 'corporate' as const,
  userId: 'stripe-webhook',
  role: 'corporate_admin' as const,
};

async function handlePaymentIntentSucceeded(
  db: Drizzle,
  pi: PaymentIntentLike,
): Promise<void> {
  if (!pi.id) return;
  const rows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.stripePaymentIntentId, pi.id));
  const invoice = rows[0];
  if (!invoice) {
    // CQA-05: not an invoice PI — it may be a quote deposit. Match the
    // quote that owns this PI and stamp deposit_paid_at. Idempotent: the
    // stripe_events dedup prevents reprocessing; the `depositPaidAt` guard
    // is belt-and-suspenders against concurrent delivery.
    const qRows = await db
      .select()
      .from(quotes)
      .where(eq(quotes.depositPaymentIntentId, pi.id));
    const quote = qRows[0];
    if (!quote) {
      logger.warn(
        { paymentIntentId: pi.id },
        'payment_intent.succeeded matched neither an invoice nor a quote deposit',
      );
      return;
    }
    if (quote.depositPaidAt) return;
    await withScope(db, WEBHOOK_SCOPE, async (tx) => {
      await tx
        .update(quotes)
        .set({ depositPaidAt: new Date(), updatedAt: new Date() })
        .where(eq(quotes.id, quote.id));
    });
    return;
  }
  const chargeId =
    pi.latest_charge ??
    pi.charges?.data?.[0]?.id ??
    `${pi.id}_charge`;

  await withScope(db, WEBHOOK_SCOPE, async (tx) => {
    await tx.insert(payments).values({
      branchId: invoice.branchId,
      invoiceId: invoice.id,
      stripePaymentIntentId: pi.id!,
      stripeChargeId: chargeId,
      amount: ((pi.amount ?? 0) / 100).toFixed(2),
      currency: pi.currency ?? 'usd',
      status: pi.status ?? 'succeeded',
    })
      .onConflictDoNothing({ target: payments.stripeChargeId });

    if (invoice.status !== 'paid') {
      await tx
        .update(invoices)
        .set({
          status: 'paid',
          paidAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, invoice.id));
    }
    // CHR-08: the commission ledger replaces royalty accounting. Credit the
    // branch manager's active comp plan for this invoice in the same tx.
    await onInvoicePaid(tx, invoice.id);
  });
}

async function handlePaymentIntentFailed(
  db: Drizzle,
  pi: PaymentIntentLike & {
    last_payment_error?: { code?: string } | null;
  },
): Promise<void> {
  if (!pi.id) return;
  const rows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.stripePaymentIntentId, pi.id));
  const invoice = rows[0];
  if (!invoice) {
    logger.warn({ paymentIntentId: pi.id }, 'payment_intent.payment_failed has no matching invoice');
    return;
  }
  const { schedulePaymentRetry } = await import('./ai-collections.js');
  const failureCode = pi.last_payment_error?.code ?? 'unknown';
  await schedulePaymentRetry(db, {
    branchId: invoice.branchId,
    invoiceId: invoice.id,
    failureCode,
  });
}

async function handleChargeRefunded(db: Drizzle, charge: ChargeLike): Promise<void> {
  const piId = charge.payment_intent;
  if (!piId) return;
  const rows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.stripePaymentIntentId, piId));
  const invoice = rows[0];
  if (!invoice) {
    logger.warn({ paymentIntentId: piId }, 'charge.refunded has no matching invoice');
    return;
  }
  const paymentRows = await db
    .select()
    .from(payments)
    .where(eq(payments.stripePaymentIntentId, piId));
  const payment = paymentRows[0];

  await withScope(db, WEBHOOK_SCOPE, async (tx) => {
    for (const r of charge.refunds?.data ?? []) {
      await tx
        .insert(refunds)
        .values({
          branchId: invoice.branchId,
          invoiceId: invoice.id,
          paymentId: payment?.id ?? null,
          stripeRefundId: r.id,
          amount: (r.amount / 100).toFixed(2),
          reason: r.reason ?? null,
          status: r.status ?? 'succeeded',
        })
        .onConflictDoNothing({ target: refunds.stripeRefundId });
    }
    // CHR-08: balancing entry in the commission ledger so the manager's
    // accrued commission is clawed back in the current period.
    await reverseInvoicePaid(tx, invoice.id, 'invoice_refunded');
  });
}

export function registerStripeWebhook(
  app: FastifyInstance,
  db: Drizzle,
  stripe: StripeClient,
): void {
  // Fastify's default JSON parser consumes the body; for signature
  // verification we need the raw bytes. Register a per-route parser
  // by declaring a fresh content-type key ('application/json') for
  // this path only.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      if (req.routeOptions?.url === '/api/v1/webhooks/stripe') {
        // Keep the raw buffer for signature verification; fastify
        // puts it on req.body unchanged.
        done(null, body);
        return;
      }
      try {
        const parsed = JSON.parse((body as Buffer).toString('utf8'));
        done(null, parsed);
      } catch (err) {
        done(err as Error);
      }
    },
  );

  app.post('/api/v1/webhooks/stripe', async (req, reply) => {
    const signature = req.headers['stripe-signature'];
    const sigHeader = Array.isArray(signature) ? signature[0]! : signature;
    if (!sigHeader) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'BAD_SIGNATURE', message: 'Missing stripe-signature header' },
      });
    }
    const raw =
      req.body instanceof Buffer
        ? req.body
        : Buffer.from(
            typeof req.body === 'string'
              ? req.body
              : JSON.stringify(req.body ?? {}),
          );

    let event;
    try {
      event = stripe.constructWebhookEvent(raw, sigHeader);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'bad signature';
      return reply.code(400).send({
        ok: false,
        error: { code: 'BAD_SIGNATURE', message: msg },
      });
    }

    const fresh = await insertEventIdempotent(db, event.id, event.type);
    if (!fresh) {
      // Replay — no side effects, 200 so Stripe stops retrying.
      return reply.code(200).send({ ok: true, data: { replay: true } });
    }

    try {
      switch (event.type) {
        case 'payment_intent.succeeded':
          await handlePaymentIntentSucceeded(
            db,
            (event.data.object ?? {}) as PaymentIntentLike,
          );
          break;
        case 'payment_intent.payment_failed':
          // Phase 12: schedule a payment_retries row based on the
          // Stripe failure code. Idempotent per attemptIndex so
          // replayed webhooks don't duplicate.
          await handlePaymentIntentFailed(
            db,
            (event.data.object ?? {}) as PaymentIntentLike,
          );
          break;
        case 'charge.refunded':
          await handleChargeRefunded(db, (event.data.object ?? {}) as ChargeLike);
          break;
        default:
          logger.debug({ type: event.type, id: event.id }, 'stripe webhook: unhandled type');
      }
    } catch (err) {
      // A side-effect failure needs retry; delete the idempotency
      // row so the next delivery is treated as fresh.
      logger.error(
        { err, eventId: event.id },
        'stripe webhook dispatch failed; removing idempotency row',
      );
      await db.delete(stripeEvents).where(eq(stripeEvents.id, event.id));
      return reply.code(500).send({
        ok: false,
        error: { code: 'WEBHOOK_DISPATCH_FAILED', message: 'Retry later' },
      });
    }

    return reply.code(200).send({ ok: true, data: { received: event.type } });
  });
}
