# Phase Gate: phase_go_live

**Validation + deploy-readiness, not a feature build. Converts the local
simulation into a pilot-ready deploy.**

**STATUS: IN PROGRESS 2026-05-20. Autonomous validation (GL-01..03) done by Claude; cred-dependent + deploy steps (GL-04..05) are Joey's runbook.**

The build is ahead of reality: everything runs on stub Stripe/BC and is
local + unpushed. This phase de-risks the first real deploy of phases
14–19 to DO App Platform + production BC + real Stripe, and proves one real
transaction end-to-end. The push (which triggers auto-deploy) is the LAST
step, by Joey's call.

## What Claude can validate autonomously (no creds)

- [ ] **GL-01 — Migration sequence.** All migrations `0001 → 0020` apply
  cleanly, in order, on a FRESH database (catches the known post-CHR ordering
  quirk where early migrations reference tables CHR later drops). Produce the
  prod migration runbook (exact order, any manual steps).
- [ ] **GL-02 — Production build.** `pnpm -r build` (or per-app `next build` +
  `tsc`) succeeds for web/api; full test suites green (api 747, web 196,
  suppliers 45, db 83). No type errors, no build-time failures.
- [ ] **GL-03 — Env + config audit.** Inventory every env var the 3 services
  need (api/web/voice) vs. `.env.example` and `.do/app.yaml`. Flag what's
  stub-vs-real and exactly what Joey must set for go-live (Stripe keys, BC
  creds, WEB_ORIGIN, publishable key, Axiom/Sentry, Google Maps, Twilio).

## What needs Joey (creds / access / the push)

- [ ] **GL-04 — Deploy runbook.** Documented steps: set real env in DO →
  push main (auto-deploy) → run migrations on DO Managed Postgres → smoke
  health checks. Includes the post-deploy validation checklist.
- [ ] **GL-05 — One real transaction.** With real Stripe + BC creds: a real
  quote → commit (real BC SQ) → accept → deposit (real card, real webhook) →
  job complete → balance invoice → balance paid (real card). This is the
  go/no-go evidence for the 30-day pilot.

## Out of scope

Load testing, multi-branch onboarding, the void/refund integrity gap
(TD-QF-01) — tracked separately. This phase is "can one branch transact for
real," not "is everything hardened."

## Gate Decision

**GL-01..03 DONE (2026-05-20, Claude):**
- GL-01 ✅ migrations 0001→0020 apply cleanly on a fresh DB; fixed the stale
  `db:migrate` (was missing 0018–0020); documented the `\copy` psql requirement.
- GL-02 ✅ api + web production builds pass; all suites green.
- GL-03 ⚠️ env audit done — `.do/app.yaml` is missing the critical payment /
  auth / WEB_ORIGIN wiring; full reference + fixes in
  `docs/deploy/GO_LIVE_RUNBOOK.md`.

**GL-04..05 = Joey's runbook** (`docs/deploy/GO_LIVE_RUNBOOK.md`): set env →
update spec → push (auto-deploy) → migrate → seed → one real transaction.
The push is the last step, on Joey's call.
