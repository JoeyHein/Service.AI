# Phase Gate: phase_invoicing_stripe

**Written before build begins. Criteria here cannot be loosened mid-phase.**

Phase 7 of 13. Finalise a draft invoice, collect payment via Stripe
Connect Standard (5% application fee to the platform), refund when
needed, deliver a receipt PDF. The tech is the trigger — they tap
"send invoice" in the PWA from phase 6, the customer pays on their
phone, the dispatch board reflects `paid` within seconds via webhook.

Every new tenant-scoped table reuses the 3-policy RLS template from
phase 3. All external services (Stripe, Resend, Twilio) are behind
pluggable adapters — the tests use stubs; production wires the real
clients from env vars.

**First Elevated Doors territory must be able to complete this loop
before phase 8 starts.**

---

## Must Pass (BLOCKERS — any failure rejects the gate)

### Data model (migration 0008)

- [ ] Migration 0008 adds `payments`, `refunds` tables with
  standard 3-policy RLS (ENABLE + FORCE + platform_admin /
  franchisor_admin / scoped) and indexed FKs.
- [ ] `franchisees` gets `stripe_account_id TEXT UNIQUE`,
  `stripe_charges_enabled BOOLEAN NOT NULL DEFAULT FALSE`,
  `stripe_payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE`,
  `stripe_details_submitted BOOLEAN NOT NULL DEFAULT FALSE`.
- [ ] `invoices` gains `stripe_payment_intent_id TEXT` and
  `payment_link_token TEXT UNIQUE` (nullable; populated at
  finalize). No change to the existing invoice_status enum —
  draft / finalized / sent / paid / void already cover this
  phase's transitions.
- [ ] Migration is reversible (`.down.sql` drops in FK-safe order).

### Stripe adapter

- [ ] `apps/api/src/stripe.ts` exports `StripeClient` interface
  with: `createConnectAccount`, `createAccountLink`,
  `retrieveAccount`, `createPaymentIntent`, `createRefund`,
  `constructWebhookEvent`. Ids carry a recognisable test prefix so
  log spelunking is easy.
- [ ] `stubStripeClient` returns deterministic ids (`acct_stub_*`,
  `pi_stub_*`, `re_stub_*`); `constructWebhookEvent` on the stub
  accepts any signature and parses the raw body.
- [ ] `realStripeClient(secretKey, webhookSecret)` is wired in
  `index.ts` when `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`
  are both set; missing either → stub with WARN log, never a
  crash on boot.

### Franchisee Connect onboarding

- [ ] `POST /api/v1/franchisees/:id/connect/onboard` creates a
  Stripe Connect Standard account (or reuses the one on file),
  returns `{ accountId, onboardingUrl }`. Franchisor-admin only
  (within their franchisor) or platform_admin; tech / dispatcher /
  CSR → 403.
- [ ] `GET /api/v1/franchisees/:id/connect/status` returns the
  current `charges_enabled` / `payouts_enabled` / `details_submitted`
  booleans.
- [ ] Web app: `/franchisor/franchisees/[id]/billing` page with
  the onboarding link + current status. Platform or franchisor
  admins only — other roles get `notFound()`.

### Invoice finalize + delivery

- [ ] `POST /api/v1/invoices/:id/finalize` transitions
  `draft → finalized`, creates a Stripe PaymentIntent in the
  franchisee's connected account with
  `application_fee_amount = round(total * 0.05 * 100)`, stores
  `stripe_payment_intent_id`, generates a unique
  `payment_link_token` (opaque, 32-byte base64url), returns the
  invoice + public payment URL.
- [ ] A franchisee without `charges_enabled = true` →
  `409 STRIPE_NOT_READY` on finalize.
- [ ] `POST /api/v1/invoices/:id/send` transitions
  `finalized → sent` and dispatches email via `EmailSender` +
  SMS via `SmsSender`. Both are pluggable; stubs log. Each
  delivery includes the public payment URL.
- [ ] Status machine rejects illegal transitions with
  `409 INVALID_TRANSITION` (reuses the phase-3 code). Sending a
  draft → 409. Finalising a sent invoice → 409.

### Customer-facing payment page

- [ ] `/invoices/[token]/pay` (no auth) renders a minimal page
  with the invoice total + a "Pay now" button that calls Stripe
  Elements client-side. Cross-token reuse impossible — token is
  the only identifier the page accepts.
- [ ] The page is rate-limited (`@fastify/rate-limit` on the
  `/api/v1/public/invoices/:token` surface that feeds it) so
  brute-forcing 32-byte tokens is not cheap.

### Stripe webhook handler

- [ ] `POST /api/v1/webhooks/stripe` accepts the raw body (Fastify
  rawBody enabled for this route only) and verifies the signature
  via `StripeClient.constructWebhookEvent`. Invalid signature →
  400 without touching the DB.
- [ ] `payment_intent.succeeded` → invoice to `paid`, insert
  `payments` row, close the loop.
- [ ] `payment_intent.payment_failed` → record the failure in a
  log table / audit row, don't change invoice status.
- [ ] `charge.refunded` → insert `refunds` row, invoice stays
  `paid` until it's been fully refunded, at which point it
  transitions to `void`.
- [ ] `account.updated` → sync the three Stripe booleans onto
  the franchisee row.
- [ ] Webhook is idempotent on `event.id` (the handler records
  the id in a `stripe_events` table and no-ops replays).

### Refund endpoint

- [ ] `POST /api/v1/invoices/:id/refund` (body:
  `{ amount?: number, reason?: string }`) creates a Stripe
  refund; full refund when `amount` is omitted or equals the
  total. Amount > `total - alreadyRefunded` → `400
  REFUND_OUT_OF_BOUNDS`.
- [ ] Only `paid` invoices are refundable → `409 INVALID_TRANSITION`
  otherwise.
- [ ] The webhook eventually fires; the refund row is recorded
  idempotently (insert-if-absent keyed by the Stripe refund id).

### PDF receipt

- [ ] `GET /api/v1/invoices/:id/receipt.pdf` streams a PDF
  rendered via `@react-pdf/renderer`. Content-type
  `application/pdf`, sensible filename header. Line items +
  customer + franchisee + totals + payment status.
- [ ] Draft invoice → `409 INVALID_TRANSITION` (no receipt for
  a draft).

### Security test suite

- [ ] ≥ 20 cases in `apps/api/src/__tests__/live-security-ip.test.ts`,
  all pass, < 30 s runtime.
- [ ] Anonymous 401 on every new authenticated endpoint.
- [ ] Cross-tenant invoice refund / finalize / send blocked
  (returns 404, no existence leak).
- [ ] Webhook without signature → 400; with wrong signature → 400.
- [ ] Refund for a non-paid invoice → 409.
- [ ] Refund amount exceeding remaining balance → 400.
- [ ] Tech cannot call `/connect/onboard` — 403 `FORBIDDEN`.

### Unit + integration test suite

- [ ] `pnpm turbo test --force` exits 0 across every workspace,
  0 cached, 0 skipped.
- [ ] No regression in phases 1–6.

---

## Must Improve Over Previous Phase

- [ ] No regression in phase_tech_mobile_pwa.
- [ ] No new `pnpm audit --audit-level=high` findings.
- [ ] Web bundle First Load JS per route stays under 200 kB;
  customer payment page + franchisor billing page each under
  130 kB (extra budget for Stripe Elements is accepted but
  capped).

---

## Security Baseline

- [ ] Every new endpoint has 401 + 403 + 400 tests.
- [ ] Stripe webhook signature verification is non-bypassable
  (no `skipSigning` env var).
- [ ] Payment page token is 32 bytes of random base64url; the
  token column has a unique index so collision is impossible.
- [ ] Application fee is computed server-side only; the client
  never submits a fee amount.

---

## Documentation

- [ ] `docs/ARCHITECTURE.md` gains a "Payments (Stripe Connect)"
  subsection (section 6e) covering the Connect Standard model,
  application-fee arithmetic, the webhook idempotency scheme,
  and the state machine extensions.
- [ ] `docs/api/invoicing-payments.md` documents every new
  endpoint: finalize, send, refund, webhook, public-by-token,
  receipt PDF.

---

## Gate Decision

_(Filled in by reviewer after all BLOCKER criteria are verified)_

**Verdict:** _(pending)_
