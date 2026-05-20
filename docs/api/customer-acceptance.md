# Customer Quote Acceptance (CQA) — phase 17

The customer-facing close: a homeowner accepts a committed quote via a
signed link and optionally pays a deposit, with no Service.AI account. The
token in the URL is the auth. Builds on SQB (quotes + `BcAiAgentProvider`),
QOC (the accept → BC order convert hop), and the invoicing-stripe Stripe
client + webhook.

## Surfaces

### Authenticated (operator, branch-scoped)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/quotes/:id/share` | Mint a customer accept link for a **committed** quote. Idempotent: re-share returns the existing live token; an expired token is replaced. Freezes the deposit amount from corporate policy onto the quote. |
| GET | `/api/v1/quotes/:id/quote.pdf` | Branded quote PDF for the operator. |

`/share` returns `{ token, url, expiresAt, depositAmountCents }`. `url` is
`${WEB_ORIGIN}/quotes/:token/accept`. Expiry = `min(now + 30d, valid_until)`.

### Public (no auth — token in path)

These run **outside RequestScope** (like `public-invoice-routes.ts`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/public/quotes/:token` | Field-leak-safe quote summary for the accept page. **Never** exposes cost, margin, or internal ids. |
| GET | `/api/v1/public/quotes/:token/pdf` | The same branded PDF, token-gated. |
| POST | `/api/v1/public/quotes/:token/accept` | Records customer acceptance (`committed → accepted`, `accepted_channel='customer_link'`) and fires the shared BC convert hop. |
| POST | `/api/v1/public/quotes/:token/deposit-intent` | Creates/re-issues the Stripe deposit PaymentIntent. Idempotent on the stored `deposit_payment_intent_id`. |

**CSRF:** the POST routes require the request `Origin`/`Referer` to match
`WEB_ORIGIN` and `Content-Type: application/json`. There is no session
cookie (the path token is the secret), so classic cookie double-submit
CSRF does not apply; this blocks the cross-site / simple-form vector. A
cross-origin or non-JSON POST returns 403.

**Status codes:** 400 bad token shape · 404 unknown token (and expired, on
GET — never distinguish "expired" from "never existed" on a read) · 410
GONE on an expired token (POST) · 409 on a bad state (accept when not
committed; deposit-intent before accept / when no deposit / already paid).

Customer-originated writes set `actor_user_id = NULL` (the customer is not a
Service.AI user; the column is a FK to `users.id`) and record the customer
in `audit_log.metadata.customerRef = 'customer:<token-prefix>'`.

## Deposit flow

```
share ──► quote.deposit_amount_cents frozen from corporate.deposit_pct
                                       (clamped to [deposit_min_cents, deposit_max_cents])
customer accepts ──► quote.status = accepted   (BC convert hop fires, parallel to deposit)
customer pays ──► POST /deposit-intent ──► Stripe PaymentIntent (single corporate account, NO application fee)
                       │  stamps quote.deposit_payment_intent_id
                       ▼
              Stripe ──► POST /api/v1/webhooks/stripe  payment_intent.succeeded
                       │  PI id matches quote.deposit_payment_intent_id
                       ▼
              quote.deposit_paid_at stamped (idempotent via stripe_events dedup)
```

Acceptance does **not** wait for the deposit — the BC order conversion
fires on accept, and the deposit is collected in parallel. Deposit amount is
always the server-frozen `deposit_amount_cents`, never request input.

## Idempotency map

| Operation | Key | Backstop |
|---|---|---|
| share | quote row (`accept_token` reused while live) | partial-unique index on `accept_token` |
| accept | quote status machine (`committed → accepted` once) | + the QOC `external_quote_id` key on the convert hop |
| deposit-intent | `quotes.deposit_payment_intent_id` | re-request retrieves the same intent's `clientSecret` (`StripeClient.retrievePaymentIntent`) |
| deposit webhook | `stripe_events.id` dedup | + `deposit_paid_at IS NULL` guard |

## Schema (migration 0019)

`quotes`: `accept_token` (partial-unique), `accept_token_expires_at`,
`accepted_channel`, `deposit_amount_cents`, `deposit_payment_intent_id`
(indexed for the webhook lookup), `deposit_paid_at`.
`corporate`: `deposit_pct`, `deposit_min_cents`, `deposit_max_cents`.

## Web

- `app/quotes/[token]/accept/page.tsx` — public, mobile-first, no app shell.
- `CardDepositForm` — Stripe Elements (`@stripe/react-stripe-js`); needs
  `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`. The first Elements integration in the
  web app; the invoice pay page (still stubbed) can adopt it.
- `QuoteBuilder` / `MobileQuoteBuilder` — "Share link" button → `/share`.

## Out of scope (follow-ups)

Deposit refund + BC order cancel on `accepted → void`; deposit-gated
fulfillment; automated link delivery (email/SMS); multi-supplier links;
partial/milestone deposits.
