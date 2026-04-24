/**
 * Stripe Connect Standard pluggable adapter (phase_invoicing_stripe).
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
 */

import Stripe from 'stripe';
import { logger } from './logger.js';

export interface StripeAccountSummary {
  id: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

export interface StripePaymentIntentSummary {
  id: string;
  clientSecret: string | null;
  status: string;
  amount: number;
  applicationFeeAmount: number | null;
  currency: string;
  onBehalfOf: string | null;
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

export interface CreateConnectAccountInput {
  franchiseeId: string;
  legalName: string;
  email?: string;
  country?: string;
}

export interface CreateAccountLinkInput {
  accountId: string;
  returnUrl: string;
  refreshUrl: string;
}

export interface CreatePaymentIntentInput {
  /** Amount in cents. */
  amount: number;
  /** Amount in cents. Computed by the caller, never the client. */
  applicationFeeAmount: number;
  currency: string;
  /** Connected account id (`acct_*`). */
  onBehalfOf: string;
  /** Destination for the transfer; same as onBehalfOf for Standard. */
  transferDestination: string;
  metadata: Record<string, string>;
}

export interface CreateRefundInput {
  paymentIntentId: string;
  /** Amount in cents. Omit for full-refund. */
  amount?: number;
  reason?: string;
  metadata?: Record<string, string>;
}

export interface CreateTransferInput {
  /** Amount in cents; sign encodes direction. Positive = platform pays
   *  the connected account; negative = platform reclaims. */
  amount: number;
  currency: string;
  /** Connected account id (`acct_*`) on the destination side. */
  destination: string;
  description?: string;
  metadata?: Record<string, string>;
}

export interface StripeTransferSummary {
  id: string;
  amount: number;
  currency: string;
  destination: string;
  status: string;
}

export interface StripeClient {
  createConnectAccount(input: CreateConnectAccountInput): Promise<StripeAccountSummary>;
  createAccountLink(input: CreateAccountLinkInput): Promise<{ url: string; expiresAt: number }>;
  retrieveAccount(accountId: string): Promise<StripeAccountSummary>;
  createPaymentIntent(input: CreatePaymentIntentInput): Promise<StripePaymentIntentSummary>;
  createRefund(input: CreateRefundInput): Promise<StripeRefundSummary>;
  createTransfer(input: CreateTransferInput): Promise<StripeTransferSummary>;
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
  async createConnectAccount({ franchiseeId }) {
    return {
      id: `acct_stub_${franchiseeId.slice(0, 8)}`,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    };
  },
  async createAccountLink({ accountId }) {
    return {
      url: `https://connect.stripe.test/setup/${accountId}`,
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    };
  },
  async retrieveAccount(accountId) {
    // Stub treats any account_id that ends with `_ready` as fully
    // onboarded — useful to flip the readiness flags in a test
    // without hand-constructing a webhook.
    const ready = accountId.endsWith('_ready');
    return {
      id: accountId,
      chargesEnabled: ready,
      payoutsEnabled: ready,
      detailsSubmitted: ready,
    };
  },
  async createPaymentIntent({
    amount,
    applicationFeeAmount,
    currency,
    onBehalfOf,
  }) {
    const id = nextId('pi');
    return {
      id,
      clientSecret: `${id}_secret_stub`,
      status: 'requires_payment_method',
      amount,
      applicationFeeAmount,
      currency,
      onBehalfOf,
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
  async createTransfer({ amount, currency, destination }) {
    return {
      id: nextId('tr'),
      amount,
      currency,
      destination,
      status: 'paid',
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

function toSummary(account: Stripe.Account): StripeAccountSummary {
  return {
    id: account.id,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    detailsSubmitted: account.details_submitted,
  };
}

function paymentIntentSummary(pi: Stripe.PaymentIntent): StripePaymentIntentSummary {
  return {
    id: pi.id,
    clientSecret: pi.client_secret,
    status: pi.status,
    amount: pi.amount,
    applicationFeeAmount: pi.application_fee_amount ?? null,
    currency: pi.currency,
    onBehalfOf:
      typeof pi.on_behalf_of === 'string'
        ? pi.on_behalf_of
        : (pi.on_behalf_of as Stripe.Account | null | undefined)?.id ?? null,
  };
}

function transferSummary(transfer: Stripe.Transfer): StripeTransferSummary {
  return {
    id: transfer.id,
    amount: transfer.amount,
    currency: transfer.currency,
    destination:
      typeof transfer.destination === 'string'
        ? transfer.destination
        : transfer.destination?.id ?? '',
    status:
      (transfer as Stripe.Transfer & { reversed?: boolean }).reversed
        ? 'reversed'
        : 'paid',
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
    async createConnectAccount({ franchiseeId, legalName, email, country }) {
      const account = await stripe.accounts.create({
        type: 'standard',
        country,
        email,
        business_profile: { name: legalName },
        metadata: { franchiseeId },
      });
      return toSummary(account);
    },
    async createAccountLink({ accountId, returnUrl, refreshUrl }) {
      const link = await stripe.accountLinks.create({
        account: accountId,
        type: 'account_onboarding',
        return_url: returnUrl,
        refresh_url: refreshUrl,
      });
      return { url: link.url, expiresAt: link.expires_at };
    },
    async retrieveAccount(accountId) {
      const account = await stripe.accounts.retrieve(accountId);
      return toSummary(account);
    },
    async createPaymentIntent({
      amount,
      applicationFeeAmount,
      currency,
      onBehalfOf,
      transferDestination,
      metadata,
    }) {
      const pi = await stripe.paymentIntents.create({
        amount,
        currency,
        application_fee_amount: applicationFeeAmount,
        on_behalf_of: onBehalfOf,
        transfer_data: { destination: transferDestination },
        metadata,
        automatic_payment_methods: { enabled: true },
      });
      return paymentIntentSummary(pi);
    },
    async createTransfer({ amount, currency, destination, description, metadata }) {
      const transfer = await stripe.transfers.create({
        amount,
        currency,
        destination,
        description,
        metadata,
      });
      return transferSummary(transfer);
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
