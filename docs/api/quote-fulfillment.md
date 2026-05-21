# Quote Fulfillment + Balance Billing (QF) — phase 18

Closes the back half of the money loop. An accepted quote (with optional
deposit) flows into a scheduled job; on completion Service.AI drafts the
balance invoice crediting the deposit, and the customer pays the balance.
Builds on CQA (accept + deposit), the dispatch board, and invoicing-stripe.

## The loop

```
quote accepted (operator OR customer link; deposit maybe paid)
   │  ensureJobForAcceptedQuote (shared by both accept paths)
   ▼
job (unassigned, jobs.quote_id → quote)  ──► dispatch board: schedule + assign
   │  job-status-machine: unassigned → scheduled → … → in_progress → completed
   ▼  POST /api/v1/jobs/:id/transition  { toStatus: 'completed' }
balance invoice (draft, invoices.quote_id → quote)
   • line items mirrored from the quote (synthetic, no pricebook item)
   • negative "Deposit (paid)" credit line  (only if deposit_paid_at set)
   • total = quote total − paid deposit  (= balance due)
   │  office finalizes (existing invoice-routes) → PaymentIntent for `total`
   ▼  customer pays via /invoices/:token/pay (Stripe Elements)
payment_intent.succeeded webhook → invoice paid
   • commission is NOT re-credited (already taken at quote commit)
```

One accepted quote → one job → one balance invoice (enforced by a partial-
unique index on `invoices.quote_id` for live rows).

## Key rules

- **Job auto-creation.** Accepting a quote with no linked job creates an
  `unassigned` job (`jobs.quote_id` set). If the quote already links a job,
  that job is linked back instead — no duplicate. Idempotent.
- **Balance invoice on completion.** Only for jobs with a linked quote, and
  only once (existing-invoice check + unique index). Plain service jobs keep
  the manual `POST /jobs/:id/invoices` flow untouched.
- **Deposit credit.** A `−deposit` "Deposit (paid)" line documents the gap;
  `invoice.total` = balance due, so finalize charges the balance. Credit is
  capped at the deposit actually paid (`deposit_paid_at` set).
- **Commission once.** Commission is credited to the closer at quote *commit*
  (`onQuoteCommitted`). The balance-invoice payment webhook **skips**
  `onInvoicePaid` for quote-linked invoices (`invoices.quote_id` set) to avoid
  double-paying. Plain service invoices credit as before.

## Surfaces

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/jobs/:id/transition` | `→ completed` drafts the balance invoice; response carries `balanceInvoiceId`. |
| GET | `/api/v1/public/invoices/:token/payment-intent` | Public, token-gated. Returns the finalized invoice PI's `clientSecret` for the pay page. 409 if not finalized / already paid. |

The balance is paid through the existing `/invoices/:token/pay` page, now
wired to the shared `StripeCardForm` (QF-05) — the invoice pay page was a stub
before this phase.

## Schema (migration 0020)

- `jobs.quote_id` `uuid` nullable FK → `quotes`, indexed. The quote a job came from.
- `invoices.quote_id` `uuid` nullable FK → `quotes`, with `invoices_quote_id_unique`
  (partial: `quote_id IS NOT NULL AND deleted_at IS NULL`) — one balance invoice per quote.
- `invoice_line_items.service_item_id` was already nullable — used for the
  synthetic quote-mirror + deposit-credit lines.

(`jobs ↔ quotes` is now a nullable FK cycle; the Drizzle schema uses an
`AnyPgColumn` annotation on `jobs.quoteId` to break the type-inference loop.)

## Void unwind (phase_void_unwind, VU)

`POST /api/v1/quotes/:id/void` on an accepted/paid quote now unwinds the
fulfillment artifacts:
- **Commission** reversed (SQB) — balancing −cents ledger row.
- **BC sales quote** voided via `provider.voidQuote` (best-effort).
- **Balance invoice** (unpaid) set to `void` inside the void transaction. A
  paid balance invoice is left alone (refunding a collected balance is a
  separate flow).
- **Deposit** refunded best-effort via Stripe `createRefund`, idempotent via
  `quotes.deposit_refunded_at` (migration 0021) — only when a deposit was
  paid and not already refunded.

Remaining gap (TD-QF-01): if the quote was already converted to a BC sales
**order**, the order stays alive — `provider.voidQuote` rejects a converted
quote and there is no order-cancel op yet.

## Performance

Balance-invoice generation is a handful of inserts inside the existing job
completion transaction — no external calls — so it adds negligible latency
to the `→ completed` transition (< 300 ms p95 budget).

## Out of scope (follow-ups)

Materials reconciliation (quoted vs. installed), multi-visit / milestone
billing, BC order status sync, deposit refund + BC order cancel on
`accepted → void`, automated invoice delivery.
