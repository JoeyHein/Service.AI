# Phase Gate: phase_ai_collections

**Written before build begins. Criteria here cannot be loosened mid-phase.**

Phase 12 of 13. AR aging shrinks without a human writing each
follow-up. When an invoice crosses day-7 past due, the AI drafts
a friendly SMS + email for the franchisee owner to review. Day
14 escalates to a firmer tone; day 30 to a final notice. In
parallel, failed-card payments retry on a schedule appropriate
to the failure code.

Every new primitive reuses established patterns — pluggable
adapters, 3-policy RLS, pure projectors + a scheduler interface
so the BullMQ wiring is optional at boot.

**After this phase, a franchisee owner sees a queue of draft
reminders each morning — one tap per invoice approves + sends
the message. No free-writing, no missed follow-ups.**

---

## Must Pass (BLOCKERS — any failure rejects the gate)

### Data model (migration 0013)

- [ ] `collections_drafts`: `id`, `franchisee_id`,
  `invoice_id`, `conversation_id`, `tone` enum
  ('friendly','firm','final'), `sms_body`, `email_subject`,
  `email_body`, `status` enum
  ('pending','approved','edited','rejected','sent','failed'),
  `decided_at?`, `decided_by_user_id?`, `sent_at?`,
  `delivery_channels` jsonb (`{ email: boolean, sms: boolean }`),
  `created_at`, `updated_at`.
- [ ] `payment_retries`: `id`, `franchisee_id`, `invoice_id`,
  `payment_id?`, `failure_code`, `scheduled_for`,
  `status` enum ('scheduled','succeeded','failed','canceled'),
  `attempt_index`, `result_ref` jsonb (Stripe id + message),
  timestamps.
- [ ] `franchisees.ai_guardrails` default gets a
  `collections` sub-object:
  `{ autoSendTone: null, cadenceDaysFriendly: 7,
  cadenceDaysFirm: 14, cadenceDaysFinal: 30 }`. A null
  `autoSendTone` means "always queue" — the gate default is
  never auto-send.
- [ ] 3-policy RLS on both new tables.
- [ ] Reversible migration.

### collections.draft capability

- [ ] `buildCollectionsDraft(input)` pure helper that produces
  a system prompt + context bundle shaped for a single AI
  turn. Tone parameter in `{ friendly | firm | final }`;
  brand voice + customer name + amount owed + invoice number
  + payment URL interpolated into the prompt.
- [ ] `collectionsDraft(deps, { scope, franchiseeId,
  invoiceId, tone })` runs a single `AIClient.turn`, parses
  `{ sms, email: { subject, body } }` from the assistant text
  (JSON-first with safe fallback), persists to
  `ai_conversations` + `ai_messages`, inserts a
  `collections_drafts` row with status=pending.

### Aging scheduler + projector

- [ ] `selectAgedInvoices(tx, { franchiseeId, now })` reads
  invoices where `status in ('sent','finalized')` and
  `finalized_at` / `sent_at` crosses a cadence threshold.
  Pure — no side effects; returns
  `[{ invoiceId, tone }]` tuples.
- [ ] `runCollectionsSweep(deps, { scope, franchiseeId })`
  loops the projector output and invokes
  `collectionsDraft` per tuple. Idempotent — a draft already
  pending for the same invoice + tone is skipped, not
  duplicated.
- [ ] `AgingScheduler` interface + default `stubAgingScheduler`
  no-op so boot never depends on a real BullMQ queue. The
  interface exposes `scheduleDaily(cb)` and `cancel()`.

### Review queue API

- [ ] `POST /api/v1/collections/run` triggers the sweep for the
  caller's franchisee. Platform + franchisor admin +
  `franchisee_owner` + `location_manager` + `dispatcher`
  only; tech / CSR → 403.
- [ ] `GET /api/v1/collections/drafts?status=...` lists scoped
  rows.
- [ ] `POST /api/v1/collections/drafts/:id/approve` sends the
  draft via the existing `EmailSender` + `SmsSender` adapters;
  flips status → sent; stamps `sent_at`.
- [ ] `POST /api/v1/collections/drafts/:id/edit` body replaces
  any of the four fields (sms_body, email_subject, email_body,
  tone), flips status → edited. Subsequent approve sends the
  edited content.
- [ ] `POST /api/v1/collections/drafts/:id/reject` flips to
  rejected without sending.
- [ ] Non-pending status on approve/edit/reject → 409
  `DRAFT_NOT_PENDING`.

### Payment retry orchestration

- [ ] Stripe webhook handler extended: on
  `payment_intent.payment_failed`, inspect the payload's
  `last_payment_error.code` and schedule a `payment_retries`
  row using the default cadence table (authentication_required
  → now+1h; card_declined → now+3d; insufficient_funds →
  now+5d; unknown → now+2d).
- [ ] `POST /api/v1/payments/retries/:id/run` (admin-only)
  creates a fresh PaymentIntent on the same invoice via the
  existing Stripe adapter + updates the `payment_retries`
  row with the result.
- [ ] Retry rows are always scoped to the franchisee; cross-
  tenant run → 404.

### Review UI + metrics

- [ ] `/collections` page for franchisee_owner +
  location_manager + dispatcher (platform/franchisor see via
  impersonation). Lists pending drafts with
  Approve/Edit/Reject. Clicking Edit opens an inline editor
  for the four fields; saving fires the edit endpoint.
- [ ] `GET /api/v1/collections/metrics` returns `dsoDays`
  (days-sales-outstanding, computed from invoices), and
  `recoveredRevenueCents` (sum of payments that resolved an
  earlier payment_retries row). Pure projector, one row.
- [ ] Top of `/collections` shows the two metrics as tiles.

### Security test suite

- [ ] ≥ 20 cases in `apps/api/src/__tests__/live-security-co.test.ts`,
  < 30 s runtime.
- [ ] Anonymous 401 on every new endpoint.
- [ ] Tech / CSR cannot trigger sweeps / approve drafts → 403.
- [ ] Cross-tenant drafts invisible → 404.
- [ ] Edit on rejected draft → 409.
- [ ] Retry run on another tenant's row → 404.
- [ ] Approve sends only when both contact fields are set (soft
  skip for missing channels mirroring the phase-7 send path).

### Unit + integration tests

- [ ] `pnpm turbo test --force` → 0 cached, 0 skipped.
- [ ] No regression in phases 1–11.

---

## Must Improve Over Previous Phase
- [ ] No regression in phase_ai_tech_assistant.
- [ ] No new `pnpm audit --audit-level=high` findings.
- [ ] `/collections` route First Load JS stays under 130 kB.

---

## Security Baseline
- [ ] Every new endpoint has 401 + 403 + 400 tests.
- [ ] Collections drafts reference invoices only inside the
  caller's franchisee — server-resolved, never trusted from
  the client.
- [ ] Approve endpoint always re-reads the draft + the invoice
  inside the transaction so a last-second status change
  rejects the send.

---

## Documentation
- [ ] `docs/ARCHITECTURE.md` section 6j "AI collections".
- [ ] `docs/api/ai-collections.md`.

---

## Gate Decision

_(Filled in by reviewer after all BLOCKER criteria are verified)_

**Verdict:** _(pending)_
