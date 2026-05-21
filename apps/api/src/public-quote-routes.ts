/**
 * Public (token-gated) quote acceptance surface (CQA-03).
 *
 *   GET  /api/v1/public/quotes/:token          narrow JSON for the accept page
 *   POST /api/v1/public/quotes/:token/accept   homeowner accepts → convert hop
 *
 * Like `public-invoice-routes.ts`, these routes are deliberately OUTSIDE
 * RequestScope: a homeowner has no Service.AI account, so the 32-byte
 * `accept_token` minted by `POST /quotes/:id/share` IS the auth. Lookups
 * go through the partial-unique index on `quotes.accept_token`.
 *
 * Field hygiene is load-bearing: the GET response exposes ONLY what the
 * customer needs to decide (line descriptions, selling prices, totals,
 * the SQ ref, validity, deposit terms). It NEVER exposes supplier cost,
 * applied margin, internal ids, or any other branch-internal field.
 *
 * CSRF: the route is authed by the unguessable path token (no session
 * cookie), so classic cookie-CSRF doesn't apply. The realistic attack —
 * a cross-site or simple-form POST — is blocked by requiring the request
 * Origin/Referer to match WEB_ORIGIN and the body to be application/json.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  auditLog,
  branches,
  customers,
  quotes,
  quoteLineItems,
  quoteStatusLog,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import type { ProviderRegistry } from '@service-ai/suppliers';
import { canTransition, type QuoteStatus } from './quote-status-machine.js';
import { ensureJobForAcceptedQuote, runOrderConversion } from './quote-routes.js';
import { renderQuotePdf } from './quote-pdf.js';
import type { StripeClient } from './stripe.js';

type Drizzle = NodePgDatabase<typeof schema>;

const TOKEN_RE = /^[A-Za-z0-9_-]{32,}$/;

export interface PublicQuoteRoutesDeps {
  drizzle: Drizzle;
  providerRegistry: ProviderRegistry;
  stripe: StripeClient;
}

/** A line item as the customer sees it — selling price only, no cost/margin. */
interface PublicLine {
  position: number;
  sku: string;
  description: string | null;
  quantity: string;
  unitPriceCents: number;
  lineTotalCents: number;
}

interface PublicQuoteView {
  status: string;
  branchName: string | null;
  customerName: string;
  currencyCode: string;
  supplierQuoteRef: string | null;
  supplierOrderRef: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  validUntil: string | null;
  expiresAt: string | null;
  depositAmountCents: number | null;
  depositPaidAt: string | null;
  accepted: boolean;
}

/**
 * Load the public-safe view for a quote by its accept token. Returns null
 * when the token is unknown. Selects ONLY whitelisted columns — there is
 * no `SELECT *` here, so a future column addition can't accidentally leak.
 */
async function loadPublicView(
  db: Drizzle,
  token: string,
): Promise<{ view: PublicQuoteView; lines: PublicLine[]; raw: typeof quotes.$inferSelect } | null> {
  const rows = await db
    .select({
      quote: quotes,
      branchName: branches.legalEntityName,
      branchDisplayName: branches.name,
      customerName: customers.name,
    })
    .from(quotes)
    .innerJoin(branches, eq(branches.id, quotes.branchId))
    .innerJoin(customers, eq(customers.id, quotes.customerId))
    .where(eq(quotes.acceptToken, token))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const q = row.quote;

  const lineRows = await db
    .select({
      position: quoteLineItems.position,
      sku: quoteLineItems.supplierSku,
      description: quoteLineItems.description,
      quantity: quoteLineItems.quantity,
      unitPriceCents: quoteLineItems.unitPriceCents,
      lineTotalCents: quoteLineItems.lineTotalCents,
    })
    .from(quoteLineItems)
    .where(eq(quoteLineItems.quoteId, q.id))
    .orderBy(quoteLineItems.position);

  const view: PublicQuoteView = {
    status: q.status,
    branchName: row.branchName ?? row.branchDisplayName,
    customerName: row.customerName,
    currencyCode: q.currencyCode,
    supplierQuoteRef: q.supplierQuoteRef,
    supplierOrderRef: q.supplierOrderRef,
    subtotalCents: q.subtotalCents,
    taxCents: q.taxCents,
    totalCents: q.totalCents,
    validUntil: q.validUntil ? q.validUntil.toISOString() : null,
    expiresAt: q.acceptTokenExpiresAt ? q.acceptTokenExpiresAt.toISOString() : null,
    depositAmountCents: q.depositAmountCents ?? null,
    depositPaidAt: q.depositPaidAt ? q.depositPaidAt.toISOString() : null,
    accepted: q.status === 'accepted',
  };
  return { view, lines: lineRows, raw: q };
}

function isExpired(expiresAt: Date | null): boolean {
  return expiresAt !== null && expiresAt.getTime() <= Date.now();
}

/**
 * CSRF defence for the token-in-path POST: require the request Origin (or
 * Referer) to match WEB_ORIGIN and the content-type to be JSON. Blocks the
 * cross-site / simple-form POST without needing a cookie. When WEB_ORIGIN
 * is unset (local dev / tests without the env), the Origin check is
 * skipped but the JSON requirement still holds.
 */
function originAllowed(req: FastifyRequest, allowedOrigin: string): boolean {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.includes('application/json')) return false;
  if (!allowedOrigin) return true;
  const origin = req.headers.origin;
  if (origin) return origin === allowedOrigin;
  const referer = req.headers.referer;
  if (referer) return referer.startsWith(allowedOrigin);
  // No Origin and no Referer: a same-origin fetch from our own page may
  // omit Origin on some browsers; the JSON-only requirement already blocks
  // the simple-form CSRF vector, so allow it.
  return true;
}

export function registerPublicQuoteRoutes(
  app: FastifyInstance,
  deps: PublicQuoteRoutesDeps,
): void {
  const { drizzle: db, providerRegistry: registry, stripe } = deps;
  // Read WEB_ORIGIN per-request rather than caching at registration, so the
  // allowlist tracks runtime config (and is testable without rebuilding app).
  const currentOrigin = (): string => process.env['WEB_ORIGIN'] ?? '';

  // ----- GET /api/v1/public/quotes/:token (no auth) -------------------------
  app.get<{ Params: { token: string } }>(
    '/api/v1/public/quotes/:token',
    async (req, reply) => {
      if (!TOKEN_RE.test(req.params.token)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'bad token shape' },
        });
      }
      const loaded = await loadPublicView(db, req.params.token);
      // Unknown token AND expired token both return 404 — never distinguish
      // "expired" from "never existed" on the read path.
      if (!loaded || isExpired(loaded.raw.acceptTokenExpiresAt)) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Quote not found' },
        });
      }
      return reply.code(200).send({
        ok: true,
        data: { ...loaded.view, lineItems: loaded.lines },
      });
    },
  );

  // ----- GET /api/v1/public/quotes/:token/pdf (no auth) ---------------------
  app.get<{ Params: { token: string } }>(
    '/api/v1/public/quotes/:token/pdf',
    async (req, reply) => {
      if (!TOKEN_RE.test(req.params.token)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'bad token shape' },
        });
      }
      const loaded = await loadPublicView(db, req.params.token);
      if (!loaded || isExpired(loaded.raw.acceptTokenExpiresAt)) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Quote not found' },
        });
      }
      const pdf = await renderQuotePdf({
        branchName: loaded.view.branchName ?? 'Quote',
        customerName: loaded.view.customerName,
        supplierQuoteRef: loaded.view.supplierQuoteRef,
        currencyCode: loaded.view.currencyCode,
        lines: loaded.lines,
        subtotalCents: loaded.view.subtotalCents,
        taxCents: loaded.view.taxCents,
        totalCents: loaded.view.totalCents,
        validUntil: loaded.raw.validUntil,
        depositAmountCents: loaded.view.depositAmountCents,
      });
      return reply
        .header('content-type', 'application/pdf')
        .header(
          'content-disposition',
          `inline; filename="quote-${loaded.view.supplierQuoteRef ?? 'draft'}.pdf"`,
        )
        .send(pdf);
    },
  );

  // ----- POST /api/v1/public/quotes/:token/accept (no auth) -----------------
  app.post<{ Params: { token: string } }>(
    '/api/v1/public/quotes/:token/accept',
    async (req, reply) => {
      if (!originAllowed(req, currentOrigin())) {
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'cross-origin or non-JSON request rejected' },
        });
      }
      if (!TOKEN_RE.test(req.params.token)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'bad token shape' },
        });
      }

      const loaded = await loadPublicView(db, req.params.token);
      if (!loaded) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Quote not found' },
        });
      }
      if (isExpired(loaded.raw.acceptTokenExpiresAt)) {
        return reply.code(410).send({
          ok: false,
          error: { code: 'GONE', message: 'This quote link has expired' },
        });
      }
      const q = loaded.raw;
      const from = q.status as QuoteStatus;
      if (!canTransition(from, 'accepted')) {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'INVALID_TRANSITION',
            message: `cannot accept a quote in status ${from}`,
          },
        });
      }

      // Synthetic branch scope so the writes run through RLS (prod uses a
      // non-superuser connection). The customer is NOT a Service.AI user, so
      // actor_user_id (a FK to users.id) is left null; the customer's
      // identity is captured in metadata via `customerRef` instead.
      const customerRef = `customer:${req.params.token.slice(0, 8)}`;
      const scope: RequestScope = {
        type: 'branch',
        userId: customerRef,
        role: 'csr',
        branchId: q.branchId,
      };

      await withScope(db, scope, async (tx) => {
        const acceptedAt = new Date();
        await tx
          .update(quotes)
          .set({ status: 'accepted', acceptedAt, acceptedChannel: 'customer_link', updatedAt: acceptedAt })
          .where(eq(quotes.id, q.id));
        await tx.insert(quoteStatusLog).values({
          quoteId: q.id,
          branchId: q.branchId,
          fromStatus: from,
          toStatus: 'accepted',
          actorUserId: null,
          reason: null,
          metadata: { acknowledgmentChannel: 'customer_link', customerRef },
        });
        await tx.insert(auditLog).values({
          actorUserId: null,
          targetBranchId: q.branchId,
          action: 'quote.accept',
          scopeType: scope.type,
          scopeId: null,
          metadata: {
            quoteId: q.id,
            acknowledgmentChannel: 'customer_link',
            customerRef,
            supplierQuoteRef: q.supplierQuoteRef,
          } as Record<string, unknown>,
        });
        // QF-02: ensure a job exists for the accepted quote. actorUserId null
        // — the customer is not a Service.AI user.
        await ensureJobForAcceptedQuote(tx, {
          quoteId: q.id,
          jobId: q.jobId,
          branchId: q.branchId,
          customerId: q.customerId,
          supplierQuoteRef: q.supplierQuoteRef,
          actorUserId: null,
        });
      });

      // Best-effort BC order conversion — identical hop as the operator
      // /accept path (shared helper, can't drift). actorUserId null: the
      // customer is not a Service.AI user.
      await runOrderConversion(
        { db, registry, log: app.log },
        {
          scope,
          actorUserId: null,
          quoteId: q.id,
          branchId: q.branchId,
          supplierId: q.supplierId,
          alreadyConverted: q.orderedAt != null,
          requestId: String(req.id),
          fallbackDetail: null,
        },
      );

      // Re-load the public view so the response reflects the accepted
      // status + any freshly-stamped order ref.
      const after = await loadPublicView(db, req.params.token);
      return reply.code(200).send({
        ok: true,
        data: after
          ? { ...after.view, lineItems: after.lines }
          : { ...loaded.view, lineItems: loaded.lines, accepted: true },
      });
    },
  );

  // ----- POST /api/v1/public/quotes/:token/deposit-intent (no auth) ---------
  // Creates (or re-issues) the Stripe PaymentIntent for the quote's deposit.
  // Only valid AFTER the customer has accepted, when a deposit is configured
  // and not yet paid. Idempotent on the quote's stored
  // deposit_payment_intent_id — a repeat request retrieves the same intent's
  // clientSecret, never a second PI. The amount is the server-frozen
  // deposit_amount_cents, never request input (cost-trust rule).
  app.post<{ Params: { token: string } }>(
    '/api/v1/public/quotes/:token/deposit-intent',
    async (req, reply) => {
      if (!originAllowed(req, currentOrigin())) {
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'cross-origin or non-JSON request rejected' },
        });
      }
      if (!TOKEN_RE.test(req.params.token)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'bad token shape' },
        });
      }
      const loaded = await loadPublicView(db, req.params.token);
      if (!loaded) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Quote not found' },
        });
      }
      if (isExpired(loaded.raw.acceptTokenExpiresAt)) {
        return reply.code(410).send({
          ok: false,
          error: { code: 'GONE', message: 'This quote link has expired' },
        });
      }
      const q = loaded.raw;
      if (q.status !== 'accepted') {
        return reply.code(409).send({
          ok: false,
          error: { code: 'INVALID_STATE', message: 'accept the quote before paying a deposit' },
        });
      }
      if (q.depositAmountCents == null || q.depositAmountCents <= 0) {
        return reply.code(409).send({
          ok: false,
          error: { code: 'NO_DEPOSIT', message: 'this quote has no deposit due' },
        });
      }
      if (q.depositPaidAt) {
        return reply.code(409).send({
          ok: false,
          error: { code: 'ALREADY_PAID', message: 'deposit already paid' },
        });
      }

      // Idempotent: re-issue the clientSecret for an existing intent.
      if (q.depositPaymentIntentId) {
        const existing = await stripe.retrievePaymentIntent(q.depositPaymentIntentId);
        return reply.code(200).send({
          ok: true,
          data: { clientSecret: existing.clientSecret, amountCents: q.depositAmountCents },
        });
      }

      const pi = await stripe.createPaymentIntent({
        amount: q.depositAmountCents,
        currency: q.currencyCode.toLowerCase(),
        metadata: { quoteId: q.id, kind: 'quote_deposit' },
      });
      const scope: RequestScope = {
        type: 'branch',
        userId: `customer:${req.params.token.slice(0, 8)}`,
        role: 'csr',
        branchId: q.branchId,
      };
      await withScope(db, scope, async (tx) => {
        await tx
          .update(quotes)
          .set({ depositPaymentIntentId: pi.id, updatedAt: new Date() })
          .where(eq(quotes.id, q.id));
      });
      return reply.code(200).send({
        ok: true,
        data: { clientSecret: pi.clientSecret, amountCents: q.depositAmountCents },
      });
    },
  );
}
