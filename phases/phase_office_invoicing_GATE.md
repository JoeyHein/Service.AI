# Phase Gate: phase_office_invoicing

**Written before build begins. Criteria here cannot be loosened mid-phase.**

**STATUS: SHIPPED 2026-05-20. OI-01..05 landed. Ref: `docs/api/office-invoicing.md`.**

**(Original: APPROVED 2026-05-20, Joey.)**

Phase 19 — makes the QF loop operable. QF-03 auto-drafts the balance invoice
on job completion, but the office has **no UI** to act on it: the (app) side
has no invoice list or detail page, and nothing calls the existing
`finalize` / `send` endpoints. The drafted invoice is stranded. This phase
gives the office a console to review, finalize, and send invoices (balance
or plain), then track payment — closing the last operable mile of the
sell→fulfill→bill loop. Closes TD-QF-03.

**Goal:** after a tech completes a quote-linked job, the office opens the
invoice from the job (or an invoices list), sees the line items + the
credited deposit + the balance due, optionally tweaks lines, clicks
**Finalize** then **Send**, and copies/sends the customer pay link. Payment
status (sent → paid) is visible. No more stranded drafts.

Depends on: QF (balance invoice + `invoices.quote_id`), invoicing-stripe
(`invoice-routes` GET/PATCH, `invoice-payment-routes` finalize/send + the
public pay page wired in QF-05), CHR (branch scoping).

Does NOT cover: a corporate cross-branch invoice console (branch-scoped
only); refunds UI; statement/AR aging beyond what the collections queue
already shows; bulk actions.

---

## Must Pass (BLOCKERS)

### API

- [ ] `GET /api/v1/invoices` — branch-scoped list. Query params: `status`
  (optional filter), `jobId`, `quoteId` (optional). Returns id, status,
  total, customer name, job title, `quoteId` (so the UI can badge "balance"),
  finalized/sent/paid timestamps, and `paymentLinkToken` when sent. Paginated
  (limit/offset, default 50). Branch-scoped via `withScope` + app-layer WHERE;
  corporate sees all, branch sees its own; cross-branch rows never leak.
- [ ] No new write endpoints — finalize (`POST /invoices/:id/finalize`), send
  (`POST /invoices/:id/send`), and line edit (`PATCH /invoices/:id`) already
  exist and are reused.
- [ ] Test matrix on the list: 401, 403→404 cross-branch, status filter,
  happy path, balance-vs-plain distinction (`quoteId` present).

### Web

- [ ] `(app)/invoices/page.tsx` — office invoice list: status badges
  (draft/finalized/sent/paid), "balance" tag for quote-linked, link to detail.
  Branch users see their branch; corporate sees all.
- [ ] `(app)/invoices/[id]/page.tsx` — invoice detail: line items (including
  the negative "Deposit (paid)" credit), subtotal/tax/total, status. Actions:
  - **Finalize** (draft → finalized) — calls the finalize endpoint, which
    creates the PaymentIntent.
  - **Send** (finalized → sent) — calls send; surfaces the customer pay link
    (`/invoices/:token/pay`) with a Copy button.
  - **Edit lines** while draft — reuse `PATCH /invoices/:id`.
- [ ] The QF-06 "balance invoice drafted" banner on the completed job links to
  the new office invoice detail page (closes TD-QF-03). The job page lists its
  invoice(s) with status + a link.
- [ ] Structural tests for both pages (file existence + key wiring: list hits
  `/api/v1/invoices`, detail calls finalize/send/PATCH + shows the pay link).

### Security / correctness

- [ ] List + detail are branch-scoped; a cross-branch invoice id is 404.
- [ ] No amounts computed client-side; the UI renders server values.
- [ ] `pnpm audit` clean; no new deps.

---

## Must Improve Over Previous Phase

- [ ] No regression: `pnpm -r exec tsc --noEmit` exits 0; api suite ≥ 744, web suite ≥ 186.

## Documentation

- [ ] `docs/api/quote-fulfillment.md` (or a short `office-invoicing.md`):
  document `GET /api/v1/invoices` + the office finalize/send flow.
- [ ] `CLAUDE.md`: note the office invoice console + that finalize/send/PATCH
  are the reused write paths.
- [ ] `docs/TECH_DEBT.md`: close TD-QF-03.

---

## Resolved decisions (2026-05-20)

1. **Edit draft lines in the office detail → YES.** Reuse `PATCH /invoices/:id`;
   the office may adjust the auto-drafted balance invoice before finalizing.
2. **Finalize + Send are separate steps → YES.** Two existing endpoints; the
   office reviews between finalize and send. No auto-send.
3. **List scope → all branch invoices + a status filter.** Not just unpaid.
   Corporate sees all branches; branch sees its own.

---

## Tasks (build order)

1. **OI-01** — `GET /api/v1/invoices` branch-scoped list endpoint + ts-rest/Zod
   + test matrix.
2. **OI-02** — `(app)/invoices` list page + nav link.
3. **OI-03** — `(app)/invoices/[id]` detail page: finalize / send / edit-lines
   + pay-link copy. Client actions via existing endpoints.
4. **OI-04** — job page shows its invoice(s) + the QF-06 banner links to the
   detail page (close TD-QF-03).
5. **OI-05** — docs + TECH_DEBT (close TD-QF-03) + structural tests.

---

## Gate Decision

**APPROVED** (2026-05-20, Joey). Build proceeds per the task order.
