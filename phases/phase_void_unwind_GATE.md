# Phase Gate: phase_void_unwind

**STATUS: SHIPPED 2026-05-20. VU-01..03 landed. Ref: `docs/api/quote-fulfillment.md` (Void unwind).**

Phase 20 — closes most of TD-QF-01. Voiding an accepted/paid quote now unwinds
the fulfillment artifacts instead of leaving them stranded.

## Shipped

- **VU-01** — migration `0021_void_unwind.sql`: `quotes.deposit_refunded_at`
  (refund idempotency + UI visibility). Drizzle schema + `db:migrate` updated.
- **VU-02** — `POST /quotes/:id/void` now:
  - voids the unpaid balance invoice (in the void tx; paid ones untouched);
  - best-effort Stripe `createRefund` of a paid deposit, idempotent via
    `deposit_refunded_at`, outside the tx (Stripe is external);
  - (already) reverses commission + voids the BC sales quote via `provider.voidQuote`.
  - `stripe` added to `QuoteRoutesDeps`.
- **VU-03** — docs + narrowed TD-QF-01.

## Resolved decisions
1. Refund the **full** deposit (a void = full cancellation).
2. Only void **unpaid** balance invoices; refunding a collected balance is a
   separate flow (out of scope).
3. **BC order cancel after conversion is out of scope** — `provider.voidQuote`
   rejects a converted quote; needs a new BC cancel-order op + `provider.cancelOrder`.
   Tracked as the TD-QF-01 remnant.

## Tests
3 cases in `live-quote-routes.test.ts`: void refunds a paid deposit
(stamps `deposit_refunded_at`); no refund when no deposit paid; void voids the
unpaid balance invoice. api suite 750 green.

## Gate Decision
**APPROVED + SHIPPED** (2026-05-20, Joey).
