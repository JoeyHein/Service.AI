# Phase Gate: phase_customer_quote_acceptance

**Written before build begins. Criteria here cannot be loosened mid-phase.**

**STATUS: SHIPPED 2026-05-20. CQA-01..07 all landed; api suite 734 + web suite 184 green. Detailed reference: `docs/api/customer-acceptance.md`.**

**(Original: APPROVED 2026-05-20, Joey. Open decisions resolved below.)**

Phase 17 — the customer-facing close. Today acceptance is recorded by a
CSR/tech on the customer's verbal yes (QOC). This phase lets the homeowner
see their quote on a real document and accept it themselves via a signed
link, with an optional deposit collected through Stripe. It bundles the
three TD items the SQB gate always intended to ship together:
TD-SQB-P2 (quote PDF), TD-SQB-P4 (customer accept link), and the deposit
collection that makes the link worth sending.

**Goal (what success looks like):** a manager commits a quote and clicks
"Share". The customer gets a link (`/quotes/:token/accept`). They open it on
their phone, see a branded PDF-quality summary — line items, total, the
SQ-XXXXXX ref, validity date — click **Accept**, and (if the branch
collects deposits) pay a deposit with a card. The Service.AI quote flips to
`accepted`, the BC order conversion fires exactly as it does on the operator
path, and the manager's board shows "Accepted by customer + deposit paid".
No Service.AI login for the customer, ever.

This phase depends on:
- `phase_supplier_quote_bridge` (SQB-01..13) — `quotes`, `external_quote_id`,
  `BcAiAgentProvider`, the `/accept` route + state machine.
- `phase_quote_order_conversion` (QOC-01..08) — `provider.convertQuoteToOrder`
  and the accept→convert hop this phase reuses verbatim from the public path.
- `phase_invoicing_stripe` — the `stripe.ts` client (`createPaymentIntent`),
  the `stripe-webhook.ts` `payment_intent.succeeded` handler, the
  `payment_link_token` public-token pattern in `public-invoice-routes.ts`,
  and the React-PDF renderer in `receipt-pdf.ts`.
- `phase_corporate_hub_redesign` (CHR-01..12) — single corporate Stripe
  account (NO `application_fee_amount`, NO Connect), branch scoping, the
  two-policy RLS template.

This phase does NOT cover:
- BC → Service.AI order status sync. Still one-way.
- Refunding a deposit on `accepted → void`. The void route reverses
  commission today; cancelling the deposit PaymentIntent + the BC order is
  a follow-up (noted in Out of scope).
- Multi-supplier accept links. Single supplier per quote (the quote already
  carries one `supplier_id`).
- A customer account / login. The token IS the auth.
- Configurator-on-the-link. The customer accepts what's quoted; they can't
  re-spec the door (that stays on the OPENDC portal/widget, TD-SQB-P5).

---

## Architectural shape

```
Manager commits quote ──► "Share" action
        │  POST /api/v1/quotes/:id/share  (branch-scoped)
        │  mints accept_token (32-byte) + accept_token_expires_at on the quote row
        ▼
   shareable URL: {WEB_ORIGIN}/quotes/{token}/accept
        │
        │  (customer opens — NO RequestScope, token is the auth)
        ▼
  apps/web public route group  apps/web/src/app/(public)/quotes/[token]/accept/
        │  GET  /api/v1/public/quotes/:token         → narrow JSON (line items, totals, branch legal name, SQ ref, validity, deposit terms)
        │  GET  /api/v1/public/quotes/:token/pdf      → branded PDF (quote-pdf.ts)
        ▼
  Customer clicks Accept
        │  POST /api/v1/public/quotes/:token/accept   (Origin/Referer allowlist + JSON-only; token-in-path is the auth)
        │     ├─ validates token + not expired + quote still in 'committed'
        │     ├─ transitions quote → 'accepted' (acknowledgmentChannel='customer_link')
        │     ├─ writes audit_log quote.accept (actor = 'customer:<token-prefix>')
        │     └─ best-effort provider.convertQuoteToOrder(...)  ← SAME hop as QOC operator path
        ▼
  (if branch collects deposits)
  Customer pays deposit via Stripe Elements on the same page
        │  POST /api/v1/public/quotes/:token/deposit-intent  → { clientSecret }
        │     stripe.createPaymentIntent({ amount: deposit_amount_cents, ... })   (single corporate account, NO application_fee)
        │     stamps quotes.deposit_payment_intent_id
        ▼
  Stripe ──► POST /api/v1/webhooks/stripe  payment_intent.succeeded
        │     existing handler extended: if the PI id matches a quote's
        │     deposit_payment_intent_id, stamp quotes.deposit_paid_at + deposit_amount_cents
        ▼
  Manager board: "Accepted by customer • Deposit $X paid • BC order SO-XXXXXX"
```

Acceptance and deposit are **decoupled**: acceptance (and the BC order hop)
fires immediately on the Accept click; the deposit is an independent
collection that does not gate conversion. Rationale in Open decisions #2.

No new external document tables. Acceptance + order ref live on the existing
`quotes` row (QOC already added the order columns). Deposit fields are new
columns on `quotes`, not a parallel `deposits` table (one deposit per quote
in v1, same 1:1 reasoning as quote→order).

---

## Must Pass (BLOCKERS — any failure rejects the gate)

### Service.AI side — schema

- [ ] Migration `0019_customer_quote_acceptance.sql` adds to `quotes`:
  - `accept_token` `text` UNIQUE (partial unique index `WHERE accept_token IS NOT NULL`), null until shared.
  - `accept_token_expires_at` `timestamptz`, null until shared.
  - `accepted_channel` `text` — 'verbal_phone' | 'verbal_inperson' | 'signed_pdf' | 'customer_link' | 'other' (was metadata-only on the status log; promote so the board can show it).
  - `deposit_amount_cents` `integer` null — the deposit asked for (frozen at share time).
  - `deposit_payment_intent_id` `text` null.
  - `deposit_paid_at` `timestamptz` null.
- [ ] Migration adds to `corporate` (deposit policy, mirrors the margin policy shape):
  - `deposit_pct` `numeric(5,2)` default `'0.00'` (0 = branch does not collect deposits).
  - `deposit_min_cents` `integer` default `0`, `deposit_max_cents` `integer` null (null = no ceiling).
- [ ] Reversible (`.down.sql` drops all of the above) + up/down/up roundtrip test `cqa-01-migration-roundtrip.test.ts`.
- [ ] No new RLS policies — new `quotes`/`corporate` columns are covered by existing policies. The PUBLIC routes deliberately run OUTSIDE RequestScope and read by token (same as `public-invoice-routes.ts`); they MUST app-layer-filter to the single token row and expose only whitelisted fields.
- [ ] Drizzle schema updated for both tables.

### Service.AI side — share + token mint (authenticated)

- [ ] `POST /api/v1/quotes/:id/share` (branch-scoped, manager/csr/tech + corporate_admin):
  - Only valid when quote is `committed` (cannot share a draft/priced/void quote) → 409 INVALID_STATE otherwise.
  - Mints `accept_token = base64url(randomBytes(32))` (reuses the `public-invoice-routes` token shape, `TOKEN_RE = /^[A-Za-z0-9_-]{32,}$/`).
  - Sets `accept_token_expires_at = now + <validity window>` (see Open decisions #3).
  - Freezes `deposit_amount_cents` from the corporate deposit policy at share time (so a later policy change doesn't move the customer's number). Resolution: `round(total * deposit_pct/100)`, clamped to `[deposit_min_cents, deposit_max_cents]`. `deposit_pct = 0` → `deposit_amount_cents = null` (no deposit step shown).
  - Idempotent: re-sharing returns the existing live token (does not rotate) unless expired, in which case it mints a fresh one.
  - Returns `{ token, url, expiresAt, depositAmountCents }`.

### Service.AI side — public surface (NO RequestScope, token-gated)

- [ ] `GET /api/v1/public/quotes/:token` — narrow JSON for the accept page:
  branch legal name, customer name, currency, line items (sku/description/qty/lineTotal — **no cost, no margin**), subtotal/tax/total, SQ-XXXXXX ref, validity date, `depositAmountCents`, and an accept/expiry status flag. 404 on unknown/expired token. NEVER exposes `supplier_unit_cost_cents`, `applied_margin_pct`, or any internal field. A field-leak test is a blocker.
- [ ] `GET /api/v1/public/quotes/:token/pdf` — the branded quote PDF (see below). 404 on unknown/expired token.
- [ ] `POST /api/v1/public/quotes/:token/accept`:
  - **CSRF protection (resolved 2026-05-20): Origin/Referer allowlist + JSON-only**, NOT
    double-submit cookie CSRF. The route is authed by the unguessable 32-byte
    token in the URL path (no session cookie), so classic cookie-CSRF doesn't
    apply; the realistic attack surface is a cross-site/simple-form POST, which
    is blocked by requiring `Origin`/`Referer` to match `WEB_ORIGIN` and
    `Content-Type: application/json`. (The "double-submit like the invoice pay
    flow" the draft referenced never existed — the invoice pay page is a stub.)
    A cross-origin or non-JSON POST returns 403.
  - Re-validates: token exists, not expired, quote still `committed` (not already accepted/void) → 409 on a bad state, 410 GONE on expired token.
  - Transitions `committed → accepted` through `canTransition` (NOT a raw UPDATE), writes the `quote_status_log` row + an `audit_log` `quote.accept` row with `actorUserId = 'customer:' + token.slice(0,8)` and `acknowledgmentChannel='customer_link'`.
  - Fires `provider.convertQuoteToOrder` best-effort, EXACTLY as the operator `/accept` path does (extract the shared logic into one helper so both call sites can't drift — closes the implicit duplication QOC left).
  - Returns the same public JSON shape with `accepted: true` and the order ref if conversion succeeded.
- [ ] `POST /api/v1/public/quotes/:token/deposit-intent` (only when `deposit_amount_cents` is set):
  - Creates a Stripe PaymentIntent on the single corporate account, `amount = deposit_amount_cents`, `metadata: { quoteId, kind: 'quote_deposit' }`. NO `application_fee_amount`, NO Connect routing (CHR-08).
  - Idempotent on the quote's existing `deposit_payment_intent_id` — re-requesting returns the same intent's `clientSecret`, never a second PI.
  - 409 if the quote isn't `accepted` yet (deposit only after accept) OR if `deposit_paid_at` is already set.

### Service.AI side — webhook extension

- [ ] `stripe-webhook.ts` `payment_intent.succeeded`: in addition to the existing invoice match, if the PI id matches a `quotes.deposit_payment_intent_id`, stamp `deposit_paid_at = now`. Idempotent via the existing `stripe_events` dedup (no double-stamp on redelivery). Unmatched PIs are a no-op, not an error.

### Quote PDF

- [ ] `apps/api/src/quote-pdf.ts` renders a branded quote PDF (model on `receipt-pdf.ts`'s React-PDF approach): branch legal name + address, customer name, SQ-XXXXXX, line items (no cost/margin), subtotal/tax/total, validity date, and deposit terms if set. Pure function `renderQuotePdf(input): Promise<Buffer>`, no DB access.
- [ ] `GET /api/v1/quotes/:id/quote.pdf` (authenticated, branch-scoped) returns the same PDF for the operator. The public route reuses the renderer.

### Idempotency + safety proofs

- [ ] Test: double-click Accept on the public route → exactly one `accepted` transition, one `convertQuoteToOrder` call (collapsed by the state machine + the QOC idempotency key), one audit row.
- [ ] Test: two `deposit-intent` requests → one Stripe PI (asserted by the stub Stripe client's create-call count), same `clientSecret`.
- [ ] Test: webhook redelivery of the same `payment_intent.succeeded` → `deposit_paid_at` stamped once (stripe_events dedup).
- [ ] Test: expired token → 410 GONE on accept, 404 on the GET/PDF.
- [ ] Test: tampered/forged token (valid shape, no row) → 404, no information leak distinguishing "expired" vs "never existed" on the GET.

### Auth + observability

- [ ] Public routes are registered OUTSIDE the RequestScope plugin (same as `public-invoice-routes.ts`); a missing/forged token can never reach a scoped query.
- [ ] No card data touches Service.AI — Stripe Elements client-side; the server only ever sees the PI id + `clientSecret`.
- [ ] `X-Service-AI-Key` redaction + `X-Request-ID` propagation unchanged (the BC hop reuses the QOC path).
- [ ] Rate limit on the public routes: stricter than the authenticated default (these are unauthenticated) — declare a per-token + per-IP limit on accept and deposit-intent.

### Test coverage matrix (per CLAUDE.md)

For `POST /api/v1/quotes/:id/share` (authenticated):
- [ ] 401 unauthenticated · 403 wrong tenant → 404 · 409 quote not committed · happy path mints token + freezes deposit · idempotent re-share returns same live token.

For the public routes (token-gated):
- [ ] 400 bad token shape · 404 unknown token · 410 expired · happy-path GET returns whitelisted fields only · **field-leak test: response body contains no cost/margin/internal keys** · accept happy path (transition + convert hop) · accept on already-accepted → 409 · cross-origin POST → 403 · non-JSON content-type → 403 · deposit-intent happy path · deposit-intent before accept → 409.

For the webhook:
- [ ] deposit PI succeeded stamps `deposit_paid_at` · redelivery is idempotent · unmatched PI is a no-op.

### Live UI

- [ ] Public accept page `apps/web/src/app/(public)/quotes/[token]/accept/page.tsx`: server-renders the quote summary from the public GET, an embedded PDF/print affordance, an Accept button, and (when a deposit is due) a Stripe Elements card form gated to appear after Accept. Mobile-first (homeowners open these on phones). No app shell / nav / auth.
- [ ] `QuoteBuilder.tsx` + `MobileQuoteBuilder.tsx`: a "Share" button on a committed quote that calls `/share` and surfaces the link with a Copy affordance; and a status line showing `Accepted by customer • Deposit $X paid` when those columns are populated.
- [ ] Manager/owner board reflects `accepted_channel = 'customer_link'` distinctly from operator-recorded acceptance (so they can see self-serve closes).

### Performance

- [ ] Public GET p95 < 400 ms (single indexed token lookup + line items; no N+1).
- [ ] PDF render p95 < 1.5 s.

---

## Must Improve Over Previous Phase

- [ ] No regression in SQB / QOC / CHR / invoicing suites.
  - **Verification:** `pnpm -r exec tsc --noEmit` exits 0; full api suite green (current baseline: 706 passing).
- [ ] Web bundle growth < 5% (one new public route group + Stripe Elements, which is already a dep from invoicing).

## Security Baseline

- [ ] `pnpm audit --audit-level=high` — no new findings.
- [ ] The public accept/deposit routes are the only new unauthenticated surface; both validate token shape before any DB work and fail closed.
- [ ] Field-leak test (above) is treated as a security blocker, not just a unit test.
- [ ] Deposit PaymentIntent amount is computed server-side from the frozen `deposit_amount_cents`, NEVER from the request body (same cost-trust rule as quote pricing).
- [ ] No secrets in code; Stripe keys via env (existing).

## Documentation

- [ ] `docs/api/supplier-quote-bridge.md` (or a new `docs/api/customer-acceptance.md`): document the share + 4 public routes + the webhook extension + a sequence diagram for the customer-link accept→convert→deposit flow.
- [ ] `docs/ARCHITECTURE.md`: note the new public route group and the deposit columns on `quotes` + `corporate`.
- [ ] `CLAUDE.md` (Service.AI): add a "Customer-facing surfaces" note — public token routes run outside RequestScope, token is the auth, never expose cost/margin.
- [ ] `docs/TECH_DEBT.md`: close TD-SQB-P2 (PDF) and TD-SQB-P4 (accept link). Note whether a deposit-refund-on-void follow-up is filed.
- [ ] `docs/LESSONS.md`: reserved CQA entry, evolver fills post-audit.

---

## Out of scope (explicitly deferred)

- Deposit refund + BC order cancel on `accepted → void`. The void route still
  only reverses commission. File a follow-up TD if this phase ships without it.
- Order conversion gated on deposit payment (see Open decisions #2).
- Email/SMS delivery of the share link. v1 surfaces the link for the manager
  to send manually (copy button); automated send waits on the Donna PA email
  stack.
- Customer re-spec / configurator on the link (TD-SQB-P5).
- Multi-supplier accept links (TD-SQB-P1).
- Partial / milestone deposits. One deposit per quote.

---

## Resolved decisions (2026-05-20)

1. **Deposit policy granularity → corporate-level only for v1.** `corporate.deposit_pct`
   resolves the amount; it is frozen onto `quotes.deposit_amount_cents` at share
   time so a later policy change never moves a customer's number. No per-quote
   manager override in v1 (file a TD if Elevated Doors asks for it).
2. **Deposit does NOT gate BC order conversion.** Acceptance fires the order hop
   immediately (identical to the operator path); the deposit is a parallel
   collection. Keeps fulfillment visibility fast and avoids coupling two external
   systems. Deposit-gated fulfillment is an explicit out-of-scope follow-up.
3. **Token validity window → `min(30 days, BC valid_until)`.** Computed at share
   time from the quote's `valid_until` (already on the row from SQB); never longer
   than the supplier honors the price.
4. **PDF engine → reuse `@react-pdf/renderer`** (the existing `receipt-pdf.ts`
   stack). Consistency, zero new BC round-trip, already a dep.

## Libraries (borrow vs build) — verified 2026-05-20

Reuse maintained/vendor-official libraries for the commoditized, security-
sensitive primitives; build only the app-specific glue.

| Concern | Decision | Status |
|---|---|---|
| Server Stripe (PaymentIntent, webhook) | `stripe` SDK | **already a dep** (`apps/api` `^22.1.0`) — reuse |
| Quote PDF render | `@react-pdf/renderer` | **already a dep** (`^4.5.1`, used by `receipt-pdf.ts`) — reuse |
| Public-route rate limiting | `@fastify/rate-limit` | **already a dep** (`^10.0.0`) — wire it on the new public routes |
| Card collection (deposit form) | `@stripe/react-stripe-js` + `@stripe/stripe-js` (official Elements) | **NEW dep in `apps/web`** — see note below |
| Expiring accept token | Node `crypto.randomBytes` (in-house opaque token) | build (matches `public-invoice-routes.ts`) — no dep |
| CSRF double-submit | in-house (proven on public invoice) | build — no dep |
| Share/accept routes, deposit-on-quote model, accept page | bespoke to this schema | build — no off-the-shelf fit |

**Stripe Elements is net-new to the web app.** The existing
`apps/web/src/app/invoices/[token]/pay/page.tsx` is a STUB — it renders a
summary + an inert "Pay" button and explicitly defers the real Elements
integration. So CQA-06 introduces `@stripe/react-stripe-js` +
`@stripe/stripe-js` (the official, free, maintained Elements SDK — the correct
"borrow") for the FIRST time, plus a `STRIPE_PUBLISHABLE_KEY` env var on the
web service. Build the deposit card form as a small reusable client component
(`<CardDepositForm>`); the invoice pay page can later adopt the same component
to finish its own stub (note as a follow-up, not in this phase's scope).
`WEB_ORIGIN` (already used by Better Auth `trustedOrigins`) is the base for the
share URL.

---

## Tasks (build order)

1. **CQA-01** — migration `0019_customer_quote_acceptance.sql` + `.down.sql` +
   roundtrip test + Drizzle schema (quotes columns + corporate deposit policy).
2. **CQA-02** — extract the accept→convert logic from the operator `/accept`
   handler into one shared helper; add `POST /quotes/:id/share` (token mint +
   deposit freeze). Authenticated test matrix.
3. **CQA-03** — public routes: GET summary (+ field-leak test), GET pdf,
   POST accept (CSRF + state machine + shared convert helper). Token-gated
   test matrix.
4. **CQA-04** — `quote-pdf.ts` renderer + authenticated `GET /quotes/:id/quote.pdf`.
5. **CQA-05** — Stripe deposit: `POST /public/quotes/:token/deposit-intent`
   (idempotent PI) + webhook extension for `payment_intent.succeeded` →
   `deposit_paid_at`. Idempotency + redelivery tests.
6. **CQA-06** — public accept page (`(public)/quotes/[token]/accept`) with
   Stripe Elements; `QuoteBuilder` + `MobileQuoteBuilder` Share button + status line.
7. **CQA-07** — perf checks (public GET, PDF) + docs + TECH_DEBT closures (P2, P4).

---

## Gate Decision

**APPROVED** (2026-05-20, Joey). All four open decisions resolved above;
library borrow/build choices verified against current deps. Build proceeds
per the task order. The only new third-party dependency is the official
Stripe Elements SDK in `apps/web` (CQA-06); everything else reuses existing
deps or in-house patterns.
