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
 * The dispatch itself runs OUTSIDE `withScope` because the event
 * has no franchisee context until we look up the invoice /
 * payment_intent / account. The queries use Drizzle directly —
 * this endpoint trusts the event payload after signature
 * verification. Every row we write is keyed on a Stripe id so
 * replay + concurrent delivery is idempotent even without RLS.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  franchisees,
  invoices,
  payments,
  refunds,
  stripeEvents,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import { logger } from './logger.js';
import type { StripeClient } from './stripe.js';

type Drizzle = NodePgDatabase<typeof schema>;

interface PaymentIntentLike {
  id?: string;
  amount?: number;
  application_fee_amount?: number | null;
  currency?: string;
  status?: string;
  latest_charge?: string | null;
  charges?: { data?: Array<{ id: string }> };
  metadata?: { invoiceId?: string; franchiseeId?: string };
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

interface AccountLike {
  id?: string;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
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
    logger.warn({ paymentIntentId: pi.id }, 'payment_intent.succeeded has no matching invoice');
    return;
  }
  const chargeId =
    pi.latest_charge ??
    pi.charges?.data?.[0]?.id ??
    `${pi.id}_charge`;

  await db.insert(payments).values({
    franchiseeId: invoice.franchiseeId,
    invoiceId: invoice.id,
    stripePaymentIntentId: pi.id,
    stripeChargeId: chargeId,
    amount: ((pi.amount ?? 0) / 100).toFixed(2),
    applicationFeeAmount: ((pi.application_fee_amount ?? 0) / 100).toFixed(2),
    currency: pi.currency ?? 'usd',
    status: pi.status ?? 'succeeded',
  })
    .onConflictDoNothing({ target: payments.stripeChargeId });

  if (invoice.status !== 'paid') {
    await db
      .update(invoices)
      .set({
        status: 'paid',
        paidAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, invoice.id));
  }
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

  for (const r of charge.refunds?.data ?? []) {
    await db
      .insert(refunds)
      .values({
        franchiseeId: invoice.franchiseeId,
        invoiceId: invoice.id,
        paymentId: payment?.id ?? null,
        stripeRefundId: r.id,
        amount: (r.amount / 100).toFixed(2),
        reason: r.reason ?? null,
        status: r.status ?? 'succeeded',
      })
      .onConflictDoNothing({ target: refunds.stripeRefundId });
  }
}

async function handleAccountUpdated(
  db: Drizzle,
  account: AccountLike,
): Promise<void> {
  if (!account.id) return;
  await db
    .update(franchisees)
    .set({
      stripeChargesEnabled: account.charges_enabled ?? false,
      stripePayoutsEnabled: account.payouts_enabled ?? false,
      stripeDetailsSubmitted: account.details_submitted ?? false,
      updatedAt: new Date(),
    })
    .where(eq(franchisees.stripeAccountId, account.id));
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
          // Phase 7 just logs failures; invoice stays 'sent' so the
          // customer can retry with the same link. A failure audit
          // table lands in phase_ai_collections.
          logger.info(
            { eventId: event.id, pi: (event.data.object as PaymentIntentLike).id },
            'payment_intent.payment_failed',
          );
          break;
        case 'charge.refunded':
          await handleChargeRefunded(db, (event.data.object ?? {}) as ChargeLike);
          break;
        case 'account.updated':
          await handleAccountUpdated(db, (event.data.object ?? {}) as AccountLike);
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
