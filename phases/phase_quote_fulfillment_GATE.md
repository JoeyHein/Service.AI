# Phase Gate: phase_quote_fulfillment

**Written before build begins. Criteria here cannot be loosened mid-phase.**

**STATUS: APPROVED 2026-05-20 (Joey). Open decisions resolved below; build proceeds per the task order.**

Phase 18 — closes the back half of the money loop. Today a quote can be
sold (commit), accepted (operator or customer link), converted to a BC order,
and have a deposit collected. But the accepted sale doesn't yet flow into
fulfillment: nobody schedules the install, and there is no *balance* invoice
that credits the deposit and collects the remainder. This phase wires
**accepted quote → scheduled job → completion → balance invoice → payment**,
reusing the dispatch board (dispatch-board phase) and the Stripe
invoice/payment surface (invoicing-stripe).

**Goal (what success looks like):** a customer accepts a quote and pays the
deposit. The job appears on the branch's dispatch board as `unassigned`; a
dispatcher schedules it and assigns a tech. The tech runs it to `completed`
on the mobile PWA. On completion, Service.AI generates a draft balance
invoice from the accepted quote — full total, minus the deposit already paid,
equals the balance due. The office finalizes + sends it; the customer pays
the balance through the existing public pay page. One sale, tracked from
"yes" to "paid in full," with the deposit correctly credited and commission
**not** double-counted.

This phase depends on:
- `phase_customer_quote_acceptance` (CQA-01..07) — `quotes` accept/deposit
  columns, `deposit_paid_at`, the public accept flow.
- `phase_quote_order_conversion` (QOC) + `phase_supplier_quote_bridge` (SQB) —
  the quote lifecycle + `closer_user_id` + the commission credit at commit.
- `phase_dispatch_board` + `phase_tech_mobile_pwa` — job scheduling,
  assignment, the `job-status-machine.ts` (`unassigned → scheduled → … →
  completed`), the tech PWA status transitions.
- `phase_invoicing_stripe` — `invoices` (job-driven), `invoice-routes.ts`
  create/finalize, the Stripe PaymentIntent + `payment_intent.succeeded`
  webhook, the public pay page (note: its card form is still a stub — see
  Open decisions #5).
- `phase_corporate_hub_redesign` — branch scoping, single corporate Stripe
  account, the commission engine (`onInvoicePaid` / `onQuoteCommitted`).

This phase does NOT cover:
- BC → Service.AI order status sync (shipped/delivered). Still one-way.
- Multi-visit / milestone jobs. One job per accepted quote, one balance
  invoice.
- Materials reconciliation against the BC order (what was quoted vs. what was
  installed). The balance invoice bills the accepted quote total as-is.
- Finishing the public invoice pay-page card form (the Elements widget) —
  unless we fold it in (Open decisions #5).

---

## Architectural shape

```
quote (accepted, deposit_paid_at maybe set)
   │  on accept (operator OR customer link), if quote.job_id is null:
   ▼
job (status=unassigned, customer/branch/title from the quote, quote_id link)
   │  dispatch board (existing): schedule + assign tech
   ▼
job: unassigned → scheduled → en_route → arrived → in_progress → completed
   │  on the completed transition (job-status-machine), if the job has a
   │  linked accepted quote and no balance invoice yet:
   ▼
balance invoice (status=draft, quote_id link)
   line items mirrored from the quote (synthetic, no pricebook serviceItem)
   + a negative "Deposit (paid)" credit line = −deposit_paid
   total = quote total; balance due = total − deposit
   │  office finalizes + sends (existing invoice-routes + Stripe)
   ▼
customer pays the balance via the public pay page
   │  payment_intent.succeeded webhook
   ▼
invoice paid. Commission is NOT re-credited (already taken at quote commit).
```

One accepted quote → one job → one balance invoice. The deposit lives on the
quote; the balance invoice credits it. No new "orders" table — the BC order
ref already lives on the quote row (QOC).

---

## Must Pass (BLOCKERS — any failure rejects the gate)

### Schema

- [ ] Migration `0020_quote_fulfillment.sql`:
  - `jobs.quote_id` `uuid` nullable, FK → `quotes(id)` `ON DELETE SET NULL`, indexed. Links a job to the quote that spawned it.
  - `invoices.quote_id` `uuid` nullable, FK → `quotes(id)` `ON DELETE SET NULL`, indexed. Marks an invoice as the balance bill for a quote (and which deposit to credit). A partial-unique index enforces **one balance invoice per quote** (`WHERE quote_id IS NOT NULL AND deleted_at IS NULL`).
  - Verify whether `invoice_line_items.service_item_id` is already nullable; if NOT, make it nullable so synthetic quote-mirror + deposit-credit lines (which have no pricebook item) can be written. Document either way.
- [ ] Reversible (`.down.sql`) + up/down/up roundtrip test `qf-01-migration-roundtrip.test.ts`.
- [ ] Drizzle schema updated; no new RLS policies (new columns covered by existing job/invoice policies).

### Accept → job

- [ ] When a quote is accepted (operator `/accept` AND public `/accept`) and
  `quote.job_id` is null, a job is created: `status='unassigned'`,
  `customer_id`/`branch_id` from the quote, `title` derived from the quote
  (e.g. `Install — SQ-XXXXXX`), `quote_id` linked back. If `quote.job_id` is
  already set, link that job's `quote_id` instead (no duplicate job).
- [ ] Job creation runs in the same `withScope` tx as the accept transition
  (no orphaned accept without a job). Idempotent: a re-accept / replay does
  not create a second job.
- [ ] The shared accept path (`runOrderConversion`'s sibling, or a new shared
  helper) is used by BOTH accept routes so they can't drift (consistent with
  the CQA pattern).

### Completion → balance invoice

- [ ] On the job `in_progress → completed` transition, if the job has a linked
  quote AND no balance invoice exists yet, generate a draft invoice:
  - `quote_id` linked, `job_id` set, `status='draft'`.
  - Line items mirrored from the quote's line items (description, qty,
    unit price) as synthetic lines (no `service_item_id`).
  - A negative credit line **"Deposit (paid)"** = `−deposit_amount_cents`
    **only when `deposit_paid_at` is set** (an unpaid/again deposit is not
    credited).
  - `total` = quote total; the amount the customer owes (balance) =
    `total − creditedDeposit`. The PaymentIntent at finalize charges the
    balance, not the full total (see Open decisions #3 for representation).
- [ ] Idempotent: completing → (reopen not allowed; `completed` is terminal)
  so generation fires once; the per-quote unique index is the backstop. A
  manual re-run or replay does not create a second balance invoice.
- [ ] If the job has NO linked quote (a plain service job), completion does
  NOT auto-generate an invoice — preserves today's manual `POST /jobs/:id/invoices` flow.

### Commission reconciliation (load-bearing)

- [ ] A balance-invoice payment for a **quote-linked** invoice does NOT call
  `onInvoicePaid` (commission was already credited to the closer at quote
  commit via `onQuoteCommitted`). Double-crediting is a correctness blocker.
  The webhook must distinguish a quote-balance invoice from a plain service
  invoice (via `invoice.quote_id`) and skip the commission credit for the
  former. A test asserts no second `commission_ledger` row after the balance
  invoice is paid.
- [ ] Plain (non-quote) service invoices keep crediting `onInvoicePaid`
  exactly as today (no regression).

### Payment

- [ ] The balance invoice finalizes through the existing `invoice-routes`
  finalize path: PaymentIntent amount = the balance (total − credited
  deposit), single corporate account, no application fee.
- [ ] The existing `payment_intent.succeeded` webhook marks the balance
  invoice paid (no change needed beyond the commission-skip above).

### Test coverage matrix (per CLAUDE.md)

- [ ] Accept (operator + public) with no existing job → one `unassigned` job
  linked to the quote; re-accept does not duplicate.
- [ ] Accept when `quote.job_id` already set → links that job, no new job.
- [ ] Job `in_progress → completed` with a linked, deposit-paid quote →
  draft balance invoice with the deposit credit; balance = total − deposit.
- [ ] Completion with a linked quote but NO deposit paid → balance = full total, no credit line.
- [ ] Completion of a plain (no-quote) job → no auto-invoice.
- [ ] Balance invoice paid → invoice `paid`, NO second commission_ledger row.
- [ ] Plain service invoice paid → commission credited (regression).
- [ ] One-balance-invoice-per-quote unique constraint enforced (second
  generation attempt is a no-op / rejected).

### Performance

- [ ] Completion → balance-invoice generation adds < 300 ms p95 to the job
  completion transition (it's a few inserts in the existing tx).

---

## Must Improve Over Previous Phase

- [ ] No regression in CQA / QOC / SQB / invoicing / dispatch / commission suites.
  - **Verification:** `pnpm -r exec tsc --noEmit` exits 0; full api suite green (current baseline: 734).
- [ ] No web bundle growth (this phase is API + a dispatch/invoice surface that already exists; net-new UI is minimal — a "balance invoice" badge on the job view at most).

## Security Baseline

- [ ] `pnpm audit --audit-level=high` — no new findings.
- [ ] Balance invoice amount is computed server-side from the quote total +
  the recorded deposit, never from request input.
- [ ] The deposit credit can never exceed the deposit actually paid
  (`deposit_paid_at` set + `deposit_amount_cents`), so a balance can't be
  driven negative by a forged request.
- [ ] Cross-tenant: a job/invoice/quote from another branch is 404, never 403.

## Documentation

- [ ] `docs/api/quote-fulfillment.md`: the accept→job→complete→balance-invoice
  flow + sequence diagram + the commission-skip rule.
- [ ] `docs/ARCHITECTURE.md`: note `jobs.quote_id` + `invoices.quote_id` links
  and the "one balance invoice per quote" rule.
- [ ] `CLAUDE.md`: a "Quote fulfillment + balance billing" note — completion
  auto-generates the balance invoice for quote-linked jobs; commission is
  credited once (at commit), never again at balance payment.
- [ ] `docs/TECH_DEBT.md`: file any deferred items (e.g. materials
  reconciliation, multi-visit).

---

## Out of scope (explicitly deferred)

- BC → Service.AI order status sync.
- Materials reconciliation (quoted vs. installed) on the balance invoice.
- Multi-visit / milestone billing.
- Deposit refund + BC order cancel on `accepted → void` (still a separate
  follow-up; this phase doesn't change void behavior).
- Automated invoice/quote delivery (email/SMS) — reuses the existing invoice
  send path; no new channel work.

---

## Resolved decisions (2026-05-20)

1. **Job auto-creation on accept → YES.** Accepting a quote (operator OR
   public link) auto-creates an `unassigned` job linked to the quote when none
   exists, so the sale lands on the dispatch board.
2. **Balance invoice on completion → auto-generate a DRAFT.** The job
   `→ completed` transition generates a draft balance invoice; the office
   reviews + finalizes + sends. Not sent automatically.
3. **Deposit credit → full-total invoice + negative "Deposit (paid)" line;
   PaymentIntent charges the balance.** The document shows total, deposit
   credit, and balance due.
4. **Commission stays at quote commit (closer); balance payment credits
   nothing.** The webhook skips `onInvoicePaid` for quote-linked invoices.
   Plain service invoices are unchanged.
5. **Finish the invoice pay-page card form → YES, fold in.** Adopt the CQA
   `CardDepositForm` (generalized to a balance/invoice payment) on the public
   invoice pay page so the balance can actually be paid by card. Done as part
   of QF-05.

---

## Tasks (build order)

1. **QF-01** — migration `0020_quote_fulfillment.sql` (+ down + roundtrip):
   `jobs.quote_id`, `invoices.quote_id` (+ one-per-quote partial-unique),
   nullable `invoice_line_items.service_item_id` if needed. Drizzle schema.
2. **QF-02** — accept → job: shared helper that ensures a job exists + links
   `quote_id`, called by both accept routes. Idempotent. Tests.
3. **QF-03** — completion → balance invoice: hook the job `→ completed`
   transition; build the invoice from the quote + deposit credit line; the
   one-per-quote guard. Tests.
4. **QF-04** — commission reconciliation: webhook skips `onInvoicePaid` for
   quote-linked invoices; regression test for plain invoices. Tests.
5. **QF-05** — balance payment: confirm finalize charges the balance; (if
   Open decision #5 = yes) wire the card form on the invoice pay page.
6. **QF-06** — UI: balance-invoice badge / link on the completed job view;
   dispatch board shows quote-linked jobs naturally (no special work expected).
7. **QF-07** — perf check + docs + TECH_DEBT.

---

## Gate Decision

**APPROVED** (2026-05-20, Joey). All five open decisions resolved above.
Build proceeds per the task order.
