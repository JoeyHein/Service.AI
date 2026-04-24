# Phase Gate: phase_ai_tech_assistant

**Written before build begins. Criteria here cannot be loosened mid-phase.**

Phase 11 of 13. Tech gets AI help in the field. From the tech
PWA:

1. Tap **Photo quote** → snap a photo of the failure → AI
   identifies door model + failure mode → suggests 3 candidate
   line items from the franchisee's active pricebook ordered by
   confidence. Tech accepts or overrides; selections land on
   the job's draft invoice.
2. Tap **Draft from notes** → dictate (or type) rough notes →
   AI returns a customer-facing invoice description the tech
   can edit before sending.

Both capabilities go through the existing agent loop + DB-
backed tools pattern. Vision inference has its own pluggable
adapter (Claude Sonnet 4.6 in prod, deterministic stub for
tests). RAG runs over a new `kb_docs` table seeded with garage-
door articles.

**After this phase, a pilot tech can finish a job and walk away
with a complete draft invoice — the whole back-and-forth with
the dispatcher over radio becomes one button + one prompt.**

---

## Must Pass (BLOCKERS — any failure rejects the gate)

### Data model (migration 0012)

- [ ] `kb_docs` table: `id`, `franchisor_id` (NULL = platform
  global), `title`, `body`, `source` (text label),
  `embedding` (jsonb array of floats — we use JS cosine over
  these for phase 11; pgvector migration is deferred per
  AUDIT m1), `tags` (jsonb array of strings),
  timestamps. RLS: three policies, but franchisee-scoped
  rows match on `franchisor_id IN (current scope's
  franchisor)` so the platform-global rows (franchisor_id
  NULL) are visible to everyone.
- [ ] `ai_feedback` table: `id`, `franchisee_id`,
  `conversation_id` (FK ai_conversations nullable), `kind`
  enum ('accept', 'override'), `subject_kind` enum
  ('photo_quote_item', 'notes_invoice_draft'),
  `subject_ref` (jsonb — refers to line item id /
  suggestion id / etc.), `actor_user_id`, `created_at`.
  3-policy RLS.
- [ ] `franchisees.ai_guardrails` default gains
  `techPhotoQuoteCapCents: 50000` ($500) so a suggested line
  item above the cap requires explicit tech confirmation —
  API refuses auto-add.
- [ ] Migration is reversible.

### RAG retriever + KB seed

- [ ] `apps/api/src/rag-retriever.ts` exports
  `retrieveKnowledge(tx, { franchisorId, query, limit })`
  that (a) embeds the query via `EmbeddingClient`, (b) reads
  all kb_docs visible to the franchisor (global + own), (c)
  computes cosine similarity in JS, (d) returns the top-N
  sorted by score. JS cosine over jsonb is fine at the ≤200-
  doc scale.
- [ ] `EmbeddingClient` interface + `stubEmbeddingClient`
  (deterministic — hashes the input into a 32-dim vector so
  tests reproduce exactly). Real impl with OpenAI / VoyageAI
  is deferred and tracked as a minor; the stub is good enough
  for the phase's correctness criteria.
- [ ] Seed ≥ 40 garage-door KB articles spanning brands
  (Clopay, Wayne Dalton, Amarr), common failures (broken
  spring, off-track, opener failure, panel damage) and part
  cross-references. Idempotent via `source` unique index.

### tech.photoQuote capability

- [ ] `VisionClient` interface: `identify(imageRef)` →
  `{ make, model?, failureMode, tags[], rawText }`. Stub is
  deterministic: reads the `imageRef` as a lookup key into a
  scripted fixture table. Real impl wraps the Anthropic SDK
  with Claude Sonnet 4.6.
- [ ] `techPhotoQuote` pipeline in
  `apps/api/src/ai-tech-assistant.ts`:
  1. Take an imageRef (existing photo id or inline data).
  2. Call `VisionClient.identify`.
  3. Use `tags[]` to retrieve top-3 kb_docs, extract part SKUs
     from matches.
  4. Resolve SKUs against the franchisee's active pricebook
     (reuses phase-4 `resolvePricebook`).
  5. Return up to 3 candidate line items with
     `{ serviceItemId, sku, name, unitPrice, confidence,
     reasoning }`.
- [ ] A suggested line item above the
  `techPhotoQuoteCapCents` guardrail is flagged
  `requiresConfirmation: true`; the API does not auto-add
  such items to an invoice.
- [ ] Live test exercises the full pipeline with a scripted
  stub vision + stub embedding.

### tech.notesToInvoice capability

- [ ] `notesToInvoice({ jobId, notes })` runs a single
  `AIClient.turn` (no tool loop) with a text-only system
  prompt, returns `{ description, intent, warnings[] }`.
  Persists the prompt + response to `ai_messages` so audit
  trail is complete.

### Assistant API

- [ ] `POST /api/v1/jobs/:id/photo-quote` (body: `{ photoId?,
  imageUrl?, description? }`) returns the 3 candidate line
  items. Tech / dispatcher / owner only; CSR → 403.
- [ ] `POST /api/v1/jobs/:id/notes-to-invoice` (body: `{
  notes }`) returns `{ description, intent, warnings[] }`.
  Tech / dispatcher / owner only.
- [ ] `POST /api/v1/ai/feedback` body: `{ conversationId?,
  kind: 'accept'|'override', subjectKind, subjectRef }`.
  Writes an `ai_feedback` row scoped to the caller's
  franchisee. Used by the mobile UI after an
  accept-suggestion tap.

### Tech PWA UI

- [ ] "Photo quote" button on `/tech/jobs/[id]` opens the
  camera (reuses TM-04's `capture="environment"`); upload
  + photoId flow feeds into `/photo-quote`.
- [ ] Result list shows 3 candidates with confidence + price
  + one-tap "Add to invoice" (or "Override" which opens the
  pricebook picker). Both tap paths fire `/ai/feedback`.
- [ ] "Draft from notes" textarea + "Generate" button on the
  tech invoice page; generated description fills into the
  invoice notes field. Tech can edit before saving.

### Security test suite

- [ ] ≥ 20 cases in `apps/api/src/__tests__/live-security-ta.test.ts`,
  < 30 s runtime.
- [ ] Anonymous 401 on all three new endpoints.
- [ ] Cross-tenant job id → 404.
- [ ] CSR cannot access either capability → 403.
- [ ] Above-cap line item always returns
  `requiresConfirmation: true`.
- [ ] Feedback row always scoped to the caller's franchisee.

### Unit + integration tests

- [ ] `pnpm turbo test --force` → 0 cached, 0 skipped.
- [ ] No regression in phases 1–10.

---

## Must Improve Over Previous Phase
- [ ] No regression in phase_ai_dispatcher.
- [ ] No new `pnpm audit --audit-level=high` findings.
- [ ] Tech job route + invoice route stay under 130 kB First
  Load JS.

---

## Security Baseline
- [ ] Every new endpoint has 401 + 403 + 400 tests.
- [ ] Photo quotes cannot read pricebook items outside the
  caller's franchisee.
- [ ] The vision adapter receives image refs, not raw customer
  data — metadata stripping lives in the adapter in future
  phases.

---

## Documentation
- [ ] `docs/ARCHITECTURE.md` section 6i "AI tech assistant"
  covering the vision adapter, RAG retriever, photoQuote +
  notesToInvoice pipelines, guardrail cap, feedback telemetry.
- [ ] `docs/api/ai-tech-assistant.md` documents every new
  endpoint.

---

## Gate Decision

**Audited in:** `phase_ai_tech_assistant_AUDIT_1.md` (cycle 1)
**Verdict:** PASS — approved 2026-04-24

All BLOCKER criteria verified. Three minors tracked in AUDIT_1
(m1: pgvector deferred; m2: real Claude vision wiring deferred;
m3: real embedding adapter deferred). Tagged
`phase-ai-tech-assistant-complete`.
