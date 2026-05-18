/**
 * Stripe single-account pluggable adapter (phase_invoicing_stripe,
 * simplified by CHR-08).
 *
 * The real implementation wraps the `stripe` SDK; the stub returns
 * deterministic canned responses so tests never hit the network and
 * CI doesn't depend on Stripe test mode availability. Env-driven
 * resolution: both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must
 * be set to upgrade to the real client; any missing var logs WARN
 * and falls back to the stub.
 *
 * All monetary amounts in this interface are in the **smallest
 * currency unit** (cents for USD) to match Stripe's SDK exactly.
 * The invoice-finalize handler converts from `numeric(12,2)` once,
 * at the adapter boundary.
 *
 * CHR-08 removed Connect onboarding and the Transfers API — every
 * charge lands on the single corporate Stripe account configured via
 * STRIPE_SECRET_KEY.
 */

import Stripe from 'stripe';
import { logger } from './logger.js';

export interface StripePaymentIntentSummary {
  id: string;
  clientSecret: string | null;
  status: string;
  amount: number;
  currency: string;
}

export interface StripeRefundSummary {
  id: string;
  status: string;
  amount: number;
  chargeId: string | null;
  paymentIntentId: string | null;
  currency: string;
}

/**
 * Narrowed shape of a webhook event the handler actually cares
 * about. `data.object` is kept as `unknown` so the handler
 * type-checks it per-type before touching fields — Stripe's own
 * types are enormous and upgrading the SDK major would ripple
 * through every import of `Stripe.Event`.
 */
export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: { object: unknown };
  created: number;
}

export interface CreatePaymentIntentInput {
  /** Amount in cents. */
  amount: number;
  currency: string;
  metadata: Record<string, string>;
}

export interface CreateRefundInput {
  paymentIntentId: string;
  /** Amount in cents. Omit for full-refund. */
  amount?: number;
  reason?: string;
  metadata?: Record<string, string>;
}

export interface StripeClient {
  createPaymentIntent(input: CreatePaymentIntentInput): Promise<StripePaymentIntentSummary>;
  createRefund(input: CreateRefundInput): Promise<StripeRefundSummary>;
  /**
   * Verify the signature on a raw webhook body, then parse it.
   * Invalid signature → throws `Error` with `code === 'BAD_SIGNATURE'`.
   */
  constructWebhookEvent(rawBody: string | Buffer, signatureHeader: string): StripeWebhookEvent;
}

// ---------------------------------------------------------------------------
// Stub
// ---------------------------------------------------------------------------

let stubCounter = 0;
function nextId(prefix: string): string {
  stubCounter += 1;
  return `${prefix}_stub_${Date.now().toString(36)}_${stubCounter}`;
}

/**
 * Deterministic stub. Every returned object is a plausible-shape
 * Stripe object so callers never branch on "real vs stub" — only
 * the `_stub_` id suffix distinguishes them in logs.
 *
 * `constructWebhookEvent` on the stub skips signature verification
 * and just parses the body. Tests pass the literal payload they
 * want dispatched.
 */
export const stubStripeClient: StripeClient = {
  async createPaymentIntent({ amount, currency }) {
    const id = nextId('pi');
    return {
      id,
      clientSecret: `${id}_secret_stub`,
      status: 'requires_payment_method',
      amount,
      currency,
    };
  },
  async createRefund({ paymentIntentId, amount }) {
    return {
      id: nextId('re'),
      status: 'succeeded',
      amount: amount ?? 0,
      chargeId: `ch_stub_${paymentIntentId}`,
      paymentIntentId,
      currency: 'usd',
    };
  },
  constructWebhookEvent(rawBody) {
    const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const parsed = JSON.parse(text) as Partial<StripeWebhookEvent>;
    if (!parsed.id || !parsed.type || !parsed.data) {
      const err = new Error('Stub webhook payload missing id/type/data');
      (err as Error & { code: string }).code = 'BAD_PAYLOAD';
      throw err;
    }
    return {
      id: parsed.id,
      type: parsed.type,
      data: parsed.data as { object: unknown },
      created: parsed.created ?? Math.floor(Date.now() / 1000),
    };
  },
};

// ---------------------------------------------------------------------------
// Real
// ---------------------------------------------------------------------------

function paymentIntentSummary(pi: Stripe.PaymentIntent): StripePaymentIntentSummary {
  return {
    id: pi.id,
    clientSecret: pi.client_secret,
    status: pi.status,
    amount: pi.amount,
    currency: pi.currency,
  };
}

function refundSummary(refund: Stripe.Refund): StripeRefundSummary {
  return {
    id: refund.id,
    status: refund.status ?? 'unknown',
    amount: refund.amount,
    chargeId: typeof refund.charge === 'string' ? refund.charge : refund.charge?.id ?? null,
    paymentIntentId:
      typeof refund.payment_intent === 'string'
        ? refund.payment_intent
        : refund.payment_intent?.id ?? null,
    currency: refund.currency,
  };
}

export function realStripeClient(
  secretKey: string,
  webhookSecret: string,
): StripeClient {
  const stripe = new Stripe(secretKey);
  return {
    async createPaymentIntent({ amount, currency, metadata }) {
      const pi = await stripe.paymentIntents.create({
        amount,
        currency,
        metadata,
        automatic_payment_methods: { enabled: true },
      });
      return paymentIntentSummary(pi);
    },
    async createRefund({ paymentIntentId, amount, reason, metadata }) {
      const refund = await stripe.refunds.create({
        payment_intent: paymentIntentId,
        amount,
        reason: reason as Stripe.RefundCreateParams.Reason | undefined,
        metadata,
      });
      return refundSummary(refund);
    },
    constructWebhookEvent(rawBody, signatureHeader) {
      try {
        const event = stripe.webhooks.constructEvent(
          rawBody,
          signatureHeader,
          webhookSecret,
        );
        return {
          id: event.id,
          type: event.type,
          data: event.data as { object: unknown },
          created: event.created,
        };
      } catch (err) {
        const wrapped = new Error(
          err instanceof Error ? err.message : 'webhook signature check failed',
        );
        (wrapped as Error & { code: string }).code = 'BAD_SIGNATURE';
        throw wrapped;
      }
    },
  };
}

/**
 * Returns the real client when both STRIPE_SECRET_KEY +
 * STRIPE_WEBHOOK_SECRET are present; otherwise the stub with a
 * WARN log. Intentionally never throws so boot never depends on
 * Stripe configuration.
 */
export function resolveStripeClient(): StripeClient {
  const key = process.env['STRIPE_SECRET_KEY'];
  const hook = process.env['STRIPE_WEBHOOK_SECRET'];
  if (!key || !hook) {
    if (key || hook) {
      logger.warn(
        { hasKey: !!key, hasHook: !!hook },
        'Stripe env vars partially set; falling back to stub client',
      );
    }
    return stubStripeClient;
  }
  return realStripeClient(key, hook);
}
