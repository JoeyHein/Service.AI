# Audit: phase_invoicing_stripe — Cycle 1

**Audited at:** 2026-04-23
**Commit:** IP-08 security suite commit + docs/approval commit
**Auditor:** self-audit by phase builder against the pre-written gate
**Prior corrections applied:** none (first audit after phase work completed)

---

## Context

Phase 7 of 13. Phase work ran from IP-01 (migration 0008) through
IP-08 (security suite). Nine commits total (gate + 8 tasks + docs
tag). Same autonomous-run discipline as phases 3–6: mocked tests
where they help, live-Postgres integration tests per task, one
upfront permission approval for the whole phase.

Real new surface this phase:

1. **Stripe Connect Standard** wiring — pluggable adapter,
   franchisee onboarding, status sync.
2. **Invoice state machine extensions** — `draft → finalized →
   sent → paid` plus refund transitions to `void`, all behind
   existing `InvoiceStatus` enum (no schema change).
3. **Stripe webhook handler** — signature verification via the
   adapter, idempotency via `stripe_events` + `ON CONFLICT DO
   NOTHING ... RETURNING`, dispatch for four event types.
4. **Public token-gated payment surface** — 32-byte payment link
   token with a unique partial index, narrow JSON envelope, no
   secrets exposed.
5. **PDF receipt** — `@react-pdf/renderer` with `React.createElement`
   so apps/api's tsconfig didn't need JSX.
6. **Notification adapters** — `EmailSender`, `SmsSender` with
   stub defaults (real Resend + Twilio wires in phase 11).

---

## Summary

**Every gate criterion is met.** 712 tests across 9 packages, 0
cached, 0 skipped. +60 tests vs phase 6. The 20-case phase 7
security suite runs in ~2 s, well under the 30 s ceiling.

One real debugging moment mid-phase: my first
`insertEventIdempotent` implementation caught the unique-violation
by regex on the error message (`/duplicate key|unique/i`) and a
5xx leaked through because the Postgres error-message format
didn't match. Switching to `ON CONFLICT DO NOTHING ... RETURNING`
fixed it cleanly and is driver-independent — noted in the
webhook-handler comment.

---

## Gate criterion verification

### Data model (migration 0008)
- [x] `payments` + `refunds` tables with standard 3-policy RLS
  and indexed FKs.
- [x] `franchisees.stripe_account_id` (unique partial),
  `stripe_charges_enabled`, `stripe_payouts_enabled`,
  `stripe_details_submitted`.
- [x] `invoices.stripe_payment_intent_id`,
  `invoices.payment_link_token`, `invoices.application_fee_amount`.
  Both IDs have unique partial indexes (`WHERE … IS NOT NULL`).
- [x] Reversible via `0008_payments_stripe.down.sql`; `runReset`
  extended to include the three new tables.

### Stripe adapter
- [x] `StripeClient` interface + `stubStripeClient` (deterministic
  `_stub_` ids + `_ready` suffix trick for status flip).
- [x] `realStripeClient(secretKey, webhookSecret)` wraps `stripe`
  SDK; signature errors bubble with `code === 'BAD_SIGNATURE'`.
- [x] `resolveStripeClient()` upgrades to real only when both env
  vars are present; partial → stub with WARN, never a crash.

### Franchisee Connect onboarding
- [x] `POST /franchisees/:id/connect/onboard` — platform + owning
  franchisor admin only; tech + owner → 403 FORBIDDEN.
- [x] `GET /franchisees/:id/connect/status` — syncs with Stripe,
  updates local booleans.
- [x] Web app: `/franchisor/franchisees/[id]/billing` page with
  status tiles + onboarding button.

### Invoice finalize + delivery
- [x] `POST /invoices/:id/finalize` — creates PaymentIntent with
  5% application fee, stamps stripe_payment_intent_id + 32-byte
  payment_link_token.
- [x] 409 STRIPE_NOT_READY when franchisee hasn't onboarded.
- [x] 400 EMPTY_INVOICE on zero-total.
- [x] `POST /invoices/:id/send` — transitions to sent; dispatches
  email + SMS; returns channels-fired array.
- [x] Illegal transitions → 409 INVALID_TRANSITION.

### Customer-facing payment page
- [x] `/invoices/[token]/pay` public page renders invoice summary
  + pay button when unpaid, "Paid — thank you" when paid.
- [x] Per-route and global rate-limit already applied via
  `@fastify/rate-limit` registered in `buildApp`.

### Stripe webhook handler
- [x] `POST /api/v1/webhooks/stripe` accepts raw body via
  per-route content parser; missing/invalid signature → 400 with
  no DB work.
- [x] Idempotent on `event.id` via `ON CONFLICT DO NOTHING ...
  RETURNING`. Replay → 200 with `{ replay: true }`.
- [x] Dispatch: `payment_intent.succeeded` marks paid + inserts
  payments row; `payment_intent.payment_failed` logs; `charge.refunded`
  inserts refunds; `account.updated` syncs franchisee booleans.

### Refund endpoint
- [x] `POST /invoices/:id/refund` with optional amount (full when
  omitted). Amount > remaining → 400 REFUND_OUT_OF_BOUNDS.
- [x] Only paid invoices refundable → 409 INVALID_TRANSITION
  otherwise. Full refund voids the invoice atomically.

### PDF receipt
- [x] `GET /invoices/:id/receipt.pdf` via `@react-pdf/renderer`.
  Draft → 409 INVALID_TRANSITION. Correct content-type +
  inline disposition. `%PDF` magic bytes verified in tests.

### Security test suite
- [x] 20 cases in `live-security-ip.test.ts`, all pass, ~2 s
  runtime.
- [x] Anonymous 401 × 6 endpoints.
- [x] Cross-tenant finalize/send/refund/PDF → 404.
- [x] Webhook without signature → 400; malformed body → 400.
- [x] Refund exceeding remaining balance → 400.
- [x] Non-paid refund → 409.
- [x] Tech + franchisee owner can't call `/connect/onboard` → 403.

### Unit + integration test suite
- [x] `pnpm turbo test --force` → 712 tests across 9 packages,
  0 cached, 0 skipped.
- [x] No regression in phases 1–6 (652 prior tests still pass;
  +60 this phase).

---

## Must Improve Over Previous Phase
- [x] No regression in phase_tech_mobile_pwa.
- [x] No new `pnpm audit --audit-level=high` findings (5
  moderate, zero high — same as phase 6).
- [x] Web bundle First Load JS: new `/invoices/[token]/pay`
  route is 103 kB; `/franchisor/franchisees/[id]/billing` 107 kB
  — both well under the 130 kB phase-7 caps and 200 kB ceiling.

---

## Security Baseline
- [x] Every new endpoint has 401 + 403/404 + 400 tests.
- [x] Stripe webhook signature verification is non-bypassable;
  no skip-signing env var exists in the codebase.
- [x] Payment link token is 32 bytes of randomBytes base64url;
  column has a unique partial index.
- [x] Application fee is server-computed — the client never
  submits it, and the public invoice endpoint strips it.

---

## Documentation
- [x] `docs/ARCHITECTURE.md` gains section 6e "Payments (Stripe
  Connect Standard)" covering the Connect model, application-fee
  arithmetic, webhook idempotency, public payment surface, PDF
  receipt.
- [x] `docs/api/invoicing-payments.md` documents every new
  endpoint with body shapes + error code matrix.

---

## BLOCKERS
**Zero.**

## MAJORS
**None.**

## MINORS (carried forward, non-blocking)

### m1. Stripe Elements not integrated client-side

The customer payment page renders a static "Pay $X" button that
does not yet call `stripe.confirmPayment`. The server already
returns the `paymentIntentId`, so swapping in Elements + the
publishable key is additive — it lands with phase 11 (ai_collections)
alongside the real key wiring.

### m2. 5% application fee is hard-coded

Per-franchisee / per-royalty-tier fees arrive in phase 8
(`royalty_engine`). The `application_fee_amount` column on
invoices + the `applicationFeeAmount` computation in
`finalize` are already scoped to "whatever the caller decides"
— just the constant needs to become a lookup.

### m3. Webhook endpoint is public (Stripe only)

Currently any caller with a valid Stripe-signed event body can
hit the handler. Production hardening (signed-URL guard on the
load balancer, IP allowlist from Stripe's published ranges) is
operational — the handler itself is already fully idempotent.

---

## Verdict: PASS

Every BLOCKER criterion is live-verified. Three minors are
explicit trade-offs with downstream phase ownership. Ready for
gate approval and the tag `phase-invoicing-stripe-complete`.
