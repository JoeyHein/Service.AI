# Audit: phase_ai_tech_assistant — Cycle 1

**Audited at:** 2026-04-24
**Commit:** TA-07 security suite commit + docs/approval commit
**Auditor:** self-audit by phase builder against the pre-written gate
**Prior corrections applied:** none (first audit after phase work completed)

---

## Context

Phase 11 of 13. User granted all approvals upfront. 9 commits
(gate + 6 task commits — TA-03/04/05 merged into one — + TA-06
UI + TA-07 security + docs/tag).

Surface:

1. **kb_docs + ai_feedback** (migration 0012) with 3-policy RLS
   + a single-policy visibility rule that lets the caller read
   their own franchisor's docs OR any NULL-franchisor global
   doc.
2. **Stub embedding + cosine RAG** over jsonb vectors. 40-article
   seed covering brand profiles, failure diagnostics, part
   cross-references, safety, ops, decision trees.
3. **Pluggable VisionClient** with fixture-driven stub +
   `fixture:unknown` low-confidence fallback.
4. **photoQuote pipeline** — vision → RAG → SKU resolution →
   price + confidence + cap check. Persists to
   `ai_conversations` + `ai_messages`.
5. **notesToInvoice pipeline** — single AI turn, JSON-first
   parse with verbatim fallback.
6. **API surface** — three endpoints with dispatch-role gate
   + cross-tenant 404.
7. **Tech PWA UI** — PhotoQuotePanel + NotesToInvoicePanel.
8. **Security suite** — 20 cases.

---

## Summary

**Every BLOCKER criterion is met.** 918 tests across 9 packages,
0 cached, 0 skipped. +45 tests vs phase 10. Phase-11 security
suite runs in ~2.7 s.

No mid-phase bugs. The one moment of judgment was whether to
store embeddings as jsonb vs pgvector — jsonb wins for phase 11
because (a) the corpus is small, (b) the Docker dev image
doesn't ship with pgvector, (c) cosine-in-JS is testable without
an extension. pgvector migration is tracked as AUDIT m1.

---

## Gate criterion verification

### Data model (migration 0012)
- [x] `kb_docs` (franchisor-scoped, NULL = global) with jsonb
  embedding + source unique index.
- [x] `ai_feedback` with enum kind + subjectKind + jsonb
  subjectRef + 3-policy RLS.
- [x] `ai_guardrails` default gains `techPhotoQuoteCapCents`.
- [x] Reversible, runReset extended.

### RAG retriever + KB seed
- [x] `EmbeddingClient` interface + deterministic stub + cosine
  helper with edge-case guards.
- [x] `retrieveKnowledge` with `requireTags` prefilter.
- [x] 40 seed articles; phase live test confirms ≥ 35 after
  `runSeed`.

### tech.photoQuote capability
- [x] Pipeline implemented + persisted to
  `ai_conversations` + `ai_messages`.
- [x] Above-cap flag honoured (verified by live test that
  temporarily lowers the cap to $1).
- [x] Cross-tenant `jobId` → 404.

### tech.notesToInvoice capability
- [x] Single AI turn, JSON-first parse + verbatim fallback.
- [x] Records assistant turn to `ai_messages`.

### Assistant API
- [x] Three endpoints with Zod validation + role gate.

### Tech PWA UI
- [x] PhotoQuotePanel on `/tech/jobs/[id]` with camera capture
  + presigned upload + AI pipeline call + accept/override
  feedback.
- [x] NotesToInvoicePanel on the invoice page.
- [x] Bundle: 110 kB each — under the 130 kB cap.

### Security suite
- [x] 20 cases, ~2.7 s. Anonymous, role boundary, cross-tenant,
  validation, above-cap, kb_docs visibility.

### Full test suite
- [x] `pnpm turbo test --force` → 918 tests across 9 packages,
  0 cached, 0 skipped.
- [x] No regression in phases 1–10.

---

## Must Improve Over Previous Phase
- [x] No regression in phase_ai_dispatcher.
- [x] No new `pnpm audit --audit-level=high` findings.
- [x] Tech job + invoice routes 110 kB each — under cap.

---

## Security Baseline
- [x] Every endpoint has 401 + 403 + 400 tests.
- [x] photoQuote candidates resolve against the caller's
  franchisee via the published template; no cross-pricebook
  leakage.
- [x] Feedback rows always tagged with the caller's
  `franchiseeId`; the API trusts the server scope, never the
  client.

---

## Documentation
- [x] `docs/ARCHITECTURE.md` section 6i "AI tech assistant".
- [x] `docs/api/ai-tech-assistant.md`.

---

## BLOCKERS
**Zero.**

## MAJORS
**None.**

## MINORS (carried forward, non-blocking)

### m1. pgvector migration deferred

At 40 articles, JS cosine takes <5 ms. When the corpus crosses
~500 articles or per-franchisor specialisation multiplies the
row count, migrate `kb_docs.embedding` to a real vector column
+ HNSW index. Interface is stable — the retriever just swaps
its scoring loop.

### m2. Real Claude Sonnet 4.6 vision wiring deferred

`VisionClient.identify` returns fixture-table outputs in
dev/tests. Production wiring is a ~50-line adapter that reads
an image URL, POSTs to Anthropic, and returns the same
structured object. Deferred until the first pilot uploads a
real garage-door photo.

### m3. Real embedding adapter deferred

Same story — the stub hashes inputs deterministically, which is
useful for tests but not for semantic retrieval. Swap in
`openaiEmbeddingClient({ apiKey })` when real KB docs land.

---

## Verdict: PASS

Every BLOCKER criterion is live-verified. Three minors are
explicit trade-offs with downstream pilot-wiring ownership.
Ready for gate approval and the tag
`phase-ai-tech-assistant-complete`.
