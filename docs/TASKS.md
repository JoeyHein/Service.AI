# Service.AI — Tasks

Format per `.claude/agents/planner.md`. Task IDs: `TASK-<PHASE>-<NUM>`.

**Planning horizon rule**: phases 1 and 2 are fully decomposed here. Phases 3–13 have anchor tasks only; the planner expands each phase's remaining tasks at phase start (stage 0 of `scripts/run-build.sh`), informed by the evolver's accumulated lessons.

---

## TASK-FND-01: Initialize monorepo skeleton

**Phase:** foundation
**Depends on:** none
**Estimated LOC:** 150

### Description
Set up pnpm workspaces, Turborepo pipeline, shared TypeScript config, ESLint, Prettier, Husky pre-commit. Create empty `apps/web`, `apps/api`, `apps/voice` and `packages/db`, `packages/contracts`, `packages/ai`, `packages/auth`, `packages/ui`.

### Acceptance criteria
- [ ] `pnpm install` resolves with no warnings from root
- [ ] `pnpm -r typecheck` passes on empty skeleton
- [ ] `pnpm -r lint` passes
- [ ] Pre-commit hook blocks commit on lint/typecheck failures
- [ ] Turborepo caching works (second `pnpm build` is <2s)

### Out of scope
Real app code. This task is purely scaffolding.

---

## TASK-FND-02: Drizzle + Postgres setup with health_checks table

**Phase:** foundation
**Depends on:** TASK-FND-01
**Estimated LOC:** 200

### Description
Wire Drizzle ORM in `packages/db`. Configure migrations via `drizzle-kit`. Create `health_checks(id, service, status, checked_at)` table. Write migration; include up + down paths.

### Acceptance criteria
- [ ] `pnpm db:migrate` applies migrations against a fresh Postgres 16 instance
- [ ] `pnpm db:migrate:down` reverts cleanly
- [ ] Integration test writes + reads `health_checks` row against the compose Postgres
- [ ] Migrations are checked in as SQL (not `drizzle-kit push`)

### Out of scope
Business tables. Tenancy schema is phase 2.

---

## TASK-FND-03: Fastify API skeleton + health endpoint

**Phase:** foundation
**Depends on:** TASK-FND-02
**Estimated LOC:** 250

### Description
Stand up `apps/api` on Fastify 5. Add plugins: `@fastify/sensible`, `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit`, `@fastify/compress`. Use pino for logging. Add `/healthz` that returns `{ok:true, db:'up'|'down', redis:'up'|'down'}`.

### Acceptance criteria
- [ ] `pnpm --filter api dev` boots on port 3001
- [ ] `GET /healthz` returns 200 when DB + Redis are reachable; 503 otherwise
- [ ] Logs are structured JSON with request id
- [ ] Graceful shutdown on SIGTERM (drains in-flight, closes pool)
- [ ] Integration test for /healthz covering up and down states

### Out of scope
Authentication, business routes.

---

## TASK-FND-04: Next.js 15 web skeleton with App Router

**Phase:** foundation
**Depends on:** TASK-FND-01
**Estimated LOC:** 200

### Description
Scaffold `apps/web` with Next.js 15, App Router, Tailwind, shadcn/ui installed. Single `/` page that renders a "Service.AI" placeholder and fetches `GET /api/v1/health` from `apps/api`.

### Acceptance criteria
- [ ] `pnpm --filter web dev` boots on port 3000
- [ ] Homepage renders; network request to api health endpoint visible
- [ ] Tailwind classes take effect (sanity check: colored div)
- [ ] `pnpm --filter web build` produces a deployable build
- [ ] Lighthouse first load <2s local

### Out of scope
Auth UI, app shell, routing beyond /.

---

## TASK-FND-05: Voice WS stub

**Phase:** foundation
**Depends on:** TASK-FND-03
**Estimated LOC:** 150

### Description
`apps/voice` Fastify server that accepts a WebSocket at `/call` and echoes messages. Proves the deploy topology supports a WS service on DO App Platform.

### Acceptance criteria
- [ ] `pnpm --filter voice dev` boots on port 8080
- [ ] WebSocket handshake at `ws://localhost:8080/call` succeeds
- [ ] Echo test: client sends "ping", receives "pong" within 50ms
- [ ] Health endpoint `GET /healthz` also exists

### Out of scope
Twilio, Deepgram, ElevenLabs integration (phase_ai_csr_voice).

---

## TASK-FND-06: ts-rest contracts + echo endpoint

**Phase:** foundation
**Depends on:** TASK-FND-03, TASK-FND-04
**Estimated LOC:** 250

### Description
Install ts-rest in `packages/contracts`. Define a minimal `/api/v1/echo` contract with Zod schema. Implement on the API side. Consume from web with typed client.

### Acceptance criteria
- [ ] Contract lives in `packages/contracts/src/echo.ts`
- [ ] API route implements it; responds `{ok:true, data:{echo:<input>}}`
- [ ] Web calls it with the ts-rest client; TypeScript errors if input/output shape drifts
- [ ] Integration test: roundtrip echo; validates response envelope shape
- [ ] 400 test for invalid input

### Out of scope
Auth, real business contracts.

---

## TASK-FND-07: CI workflow (typecheck/test/build)

**Phase:** foundation
**Depends on:** TASK-FND-01 through TASK-FND-06
**Estimated LOC:** 150

### Description
GitHub Actions workflow on push to any branch: install, typecheck, lint, test, build. On push to `main`: additionally run deploy notification (actual DO App Platform deploy is DO-native via auto-deploy).

### Acceptance criteria
- [ ] `.github/workflows/ci.yml` exists and runs on push + PR
- [ ] All checks green on a fresh clone
- [ ] Caching of pnpm store reduces second run to <3 min
- [ ] Failed lint/typecheck/test fails the workflow
- [ ] Required status checks enforced on main via branch protection (documented; manual setting)

### Out of scope
E2E, performance tests (added in later phases).

---

## TASK-FND-08: Observability — Axiom logs + Sentry errors

**Phase:** foundation
**Depends on:** TASK-FND-03, TASK-FND-04, TASK-FND-05
**Estimated LOC:** 200

### Description
Ship JSON pino logs from api + voice to Axiom via `@axiomhq/pino`. Init Sentry in web + api + voice with tracing. Env-driven DSN; silent in dev if unset.

### Acceptance criteria
- [ ] A test log line from api appears in Axiom within 10s
- [ ] A thrown error in api reports to Sentry with request context
- [ ] Web client errors report to Sentry
- [ ] Secrets never logged (redact list covers email tokens, cookies, authorization header)
- [ ] Disabled in local dev by default

### Out of scope
OpenTelemetry traces (add in later phase if needed).

---

## TASK-FND-09: DO App Platform spec + auto-deploy

**Phase:** foundation
**Depends on:** TASK-FND-07
**Estimated LOC:** 100

### Description
`.do/app.yaml` describing three components (web, api, voice), environment variables, managed Postgres and Redis references. Wire auto-deploy on push to main.

### Acceptance criteria
- [ ] `.do/app.yaml` validates via `doctl apps spec validate`
- [ ] First deploy to staging creates all three services + databases
- [ ] `/healthz` on staging api returns 200
- [ ] Push to main triggers redeploy within 2 min
- [ ] Rollback procedure documented in README

### Out of scope
Prod environment spec — cloned from staging once staging is stable.

---

## TASK-FND-10: Docker Compose dev parity

**Phase:** foundation
**Depends on:** TASK-FND-02, TASK-FND-03, TASK-FND-04, TASK-FND-05
**Estimated LOC:** 150

### Description
Update existing `docker-compose.yml` to run web + api + voice + postgres + redis together for full-stack local dev. Ensure hot reload works via volume mounts.

### Acceptance criteria
- [ ] `docker compose up` brings all services up healthy in <60s
- [ ] Editing source triggers reload in the correct service within 2s
- [ ] All services can reach each other by service name
- [ ] Ports: web 3000, api 3001, voice 8080, postgres 5434, redis 6381 (match current compose)

### Out of scope
Production-grade compose (we use App Platform for that).

---

---

## TASK-TEN-01: Better Auth integration

**Phase:** tenancy_franchise
**Depends on:** TASK-FND-09
**Estimated LOC:** 400

### Description
Install Better Auth in api + web. Drizzle adapter. Email/password + magic link providers. Session via httpOnly cookies. `packages/auth` exports middleware + helpers.

### Acceptance criteria
- [ ] Sign up, sign in, sign out work end to end
- [ ] Session cookie is httpOnly, sameSite=lax, secure in prod
- [ ] `users`, `sessions`, `accounts`, `verifications` tables exist per Better Auth schema
- [ ] `/api/v1/me` returns the current user when authenticated, 401 otherwise
- [ ] Magic link email is actually delivered (Resend; dev mode logs the link instead)

### Out of scope
Role assignment (next task), impersonation (TEN-04).

---

## TASK-TEN-02: Franchise hierarchy schema

**Phase:** tenancy_franchise
**Depends on:** TASK-TEN-01
**Estimated LOC:** 350

### Description
Create tables: `franchisors`, `franchisees`, `locations`, `memberships`, `audit_log`. Define enums for `scope_type` and `role`. Write migration with indexes on every foreign key and on `(user_id, scope_type, scope_id)`.

### Acceptance criteria
- [ ] Migration applies and reverts cleanly
- [ ] Foreign-key cascades documented (e.g. deleting a franchisee deletes its locations but soft-deletes memberships)
- [ ] Seed: Elevated Doors franchisor + one franchisee ("Elevated Doors — Denver") + one location ("Denver Metro")
- [ ] Constraint: user can have at most one active membership per `(scope_type, scope_id)`
- [ ] Unique `email` on users (via Better Auth); phone column added with partial unique where phone is not null

### Out of scope
Enforcement in API (next task).

---

## TASK-TEN-03: RequestScope middleware + row-level scoping

**Phase:** tenancy_franchise
**Depends on:** TASK-TEN-02
**Estimated LOC:** 450

### Description
Fastify plugin that on every authenticated request resolves the effective `RequestScope` from memberships + optional impersonation header, attaches it to `request.scope`. Provide a `scopedQuery(scope)` helper that composes `WHERE franchisee_id = scope.franchisee_id` and friends.

### Acceptance criteria
- [ ] `RequestScope` type is a discriminated union per `scope_type`
- [ ] `scopedQuery` refuses to return rows outside scope (verified by a targeted test hitting raw SQL)
- [ ] Platform admin bypass is explicit (requires `X-Platform-Override` header + audit log)
- [ ] At least 20 IDOR tests across representative tables pass
- [ ] Postgres RLS policies enabled as defense in depth; documented how session GUCs are set

### Out of scope
Per-role action authorization (role-matrix enforced in later tasks on a per-endpoint basis).

---

## TASK-TEN-04: Franchisor impersonation + audit

**Phase:** tenancy_franchise
**Depends on:** TASK-TEN-03
**Estimated LOC:** 300

### Description
Add `X-Impersonate-Franchisee` header flow. Only franchisor admins may set it; validated against their franchisor ownership of the target. Every impersonated read/write creates an `audit_log` row.

### Acceptance criteria
- [ ] Non-franchisor-admin sending the header gets 403
- [ ] Franchisor admin of franchisor A cannot impersonate franchisee of franchisor B
- [ ] Audit row written with actor, target, action, franchisee_id, scope_type, metadata
- [ ] UI banner appears on frontend when impersonating (web task in TEN-07)
- [ ] Test coverage: happy path, unauthorized, cross-franchisor, impersonation of non-existent franchisee

### Out of scope
UI for audit log (TEN-08).

---

## TASK-TEN-05: Invitation flow (api)

**Phase:** tenancy_franchise
**Depends on:** TASK-TEN-03
**Estimated LOC:** 350

### Description
Invite endpoints for franchisors to invite franchisor admins; franchisees to invite location managers, dispatchers, techs, CSRs. Token-based; email delivery via Resend. Redemption creates membership.

### Acceptance criteria
- [ ] Invite token is single-use, expires in 72h, cryptographically random (32 bytes)
- [ ] Role invited is validated against inviter's scope (a location manager can only invite dispatcher/tech/csr)
- [ ] Redemption either signs in the existing user or routes to sign-up
- [ ] Revoking a pending invite is idempotent
- [ ] 401/403/400/edge-case tests all pass

### Out of scope
Bulk invites; invite templates (v2).

---

## TASK-TEN-06: Auth UI (web)

**Phase:** tenancy_franchise
**Depends on:** TASK-TEN-01, TASK-TEN-05
**Estimated LOC:** 500

### Description
Web routes: `/signin`, `/signup`, `/verify`, `/accept-invite/[token]`. App shell showing current user, scope (franchisee name / location), role; sign out. Protected layout wrapper that redirects to /signin.

### Acceptance criteria
- [ ] All routes render and function on mobile + desktop
- [ ] Accept-invite flow validates token and creates membership
- [ ] Server components fetch session server-side; no session leaks to client bundles
- [ ] E2E: user receives invite email (mocked), accepts, lands on scoped dashboard
- [ ] Sign-out invalidates session server-side

### Out of scope
Password reset (covered by magic-link fallback in v1).

---

## TASK-TEN-07: Impersonation UI + HQ banner

**Phase:** tenancy_franchise
**Depends on:** TASK-TEN-04, TASK-TEN-06
**Estimated LOC:** 250

### Description
Franchisor admin web: list of franchisees with "View as" button. Clicking sets impersonation state (cookie or session flag); UI renders a permanent red banner "HQ VIEWING: <franchisee name> · return to network view".

### Acceptance criteria
- [ ] Banner is always visible while impersonating, in all routes
- [ ] "Return to network" clears impersonation
- [ ] Impersonation state survives reload
- [ ] Every API call made while impersonating sends the header
- [ ] E2E: franchisor admin impersonates, makes a write, audit log is inspected

### Out of scope
Audit log UI (TEN-08).

---

## TASK-TEN-08: Audit log viewer

**Phase:** tenancy_franchise
**Depends on:** TASK-TEN-04
**Estimated LOC:** 300

### Description
Minimal `/franchisor/audit` route listing audit entries with filters by actor, franchisee, action, date. Paginated. Read-only. Accessible to platform_admin and franchisor_admin.

### Acceptance criteria
- [ ] Lists at least 10k rows with smooth pagination
- [ ] Filters work and combine
- [ ] Search by actor email
- [ ] Non-authorized users get 403
- [ ] Loads <500ms p95 with representative data

### Out of scope
Retention policies and archival (operations concern later).

---

## TASK-TEN-09: Seed + fixtures

**Phase:** tenancy_franchise
**Depends on:** TASK-TEN-02, TASK-TEN-05
**Estimated LOC:** 250

### Description
Repeatable seed script creating: Elevated Doors franchisor; 2 franchisees (Denver, Austin); each with 1 location, 1 owner, 1 manager, 1 dispatcher, 2 techs, 1 CSR. One platform admin (joey@opendc.ca). Realistic names and phone numbers.

### Acceptance criteria
- [ ] `pnpm seed` is idempotent (safe to re-run)
- [ ] All seeded users can sign in with a documented password
- [ ] E2E test suite uses seeded data for auth fixtures
- [ ] Reset script (`pnpm seed:reset`) wipes tenant data but preserves migrations

### Out of scope
Business data (customers, jobs) — added by later phase seeds.

---

## TASK-TEN-10: Security test suite

**Phase:** tenancy_franchise
**Depends on:** TASK-TEN-03, TASK-TEN-04, TASK-TEN-05, TASK-TEN-06
**Estimated LOC:** 500

### Description
Dedicated security test file covering: anonymous access to protected routes, wrong-tenant access, privilege escalation via role tampering, impersonation misuse, invite token reuse, session hijacking prevention.

### Acceptance criteria
- [ ] ≥40 test cases, all pass
- [ ] Covers every protected endpoint at least for 401 and 403
- [ ] Includes negative tests that would pass if scoping were missing
- [ ] Runs in <60s
- [ ] CI fails if coverage in auth package drops below 90%

### Out of scope
Pen-testing / DAST (operations / scheduled work, not build phase).

---

---

## phase_customer_job anchors

- **TASK-CJ-01** — customers + jobs schema + migrations
- **TASK-CJ-02** — customers CRUD API with tenant scoping
- **TASK-CJ-03** — jobs CRUD API with status state machine
- **TASK-CJ-04** — Google Places autocomplete integration
- **TASK-CJ-05** — web: customer list + detail + create
- **TASK-CJ-06** — web: job list + detail + create
- **TASK-CJ-07** — DO Spaces photo upload (presigned URLs)
- **TASK-CJ-08** — IDOR + authorization test suite for new routes

_Planner expands this phase fully at phase start, informed by evolver lessons from foundation + tenancy._

---

## phase_pricebook anchors
- **TASK-PB-01** — catalog tables + migrations
- **TASK-PB-02** — HQ template publish API + UI
- **TASK-PB-03** — franchisee override API with floor/ceiling validation
- **TASK-PB-04** — garage-door seed catalog (~50 items)

---

## phase_dispatch_board anchors
- **TASK-DB-01** — board layout with dnd-kit
- **TASK-DB-02** — assignment API
- **TASK-DB-03** — SSE live update stream
- **TASK-DB-04** — job detail with static Google Map
- **TASK-DB-05** — latency test harness (k6 + Playwright)

---

## phase_tech_mobile_pwa anchors
- **TASK-TM-01** — PWA manifest + service worker
- **TASK-TM-02** — tech route set + nav
- **TASK-TM-03** — IndexedDB offline queue + sync
- **TASK-TM-04** — camera capture + photo upload
- **TASK-TM-05** — line item picker + invoice draft
- **TASK-TM-06** — web push wiring

---

## phase_invoicing_stripe anchors
- **TASK-INV-01** — invoice + payment schema
- **TASK-INV-02** — Stripe Connect onboarding flow
- **TASK-INV-03** — PaymentIntent creation with app fee
- **TASK-INV-04** — Stripe webhook handler
- **TASK-INV-05** — receipt PDF generation
- **TASK-INV-06** — invoice delivery (email + SMS)

---

## phase_royalty_engine anchors
- **TASK-ROY-01** — agreement + rules schema
- **TASK-ROY-02** — rule evaluator (all 4 rule types + combinations)
- **TASK-ROY-03** — monthly statement job
- **TASK-ROY-04** — Stripe Transfers reconciliation
- **TASK-ROY-05** — franchisor UI for authoring agreements
- **TASK-ROY-06** — franchisee statement view

---

## phase_ai_csr_voice anchors
- **TASK-CSR-01** — Twilio Media Streams handler
- **TASK-CSR-02** — Deepgram streaming ASR integration
- **TASK-CSR-03** — Claude intent loop with tool list
- **TASK-CSR-04** — ElevenLabs TTS integration
- **TASK-CSR-05** — Twilio phone provisioning flow
- **TASK-CSR-06** — call recording → DO Spaces
- **TASK-CSR-07** — guardrails + transfer-to-human
- **TASK-CSR-08** — synthetic-call test harness

---

## phase_ai_dispatcher anchors
- **TASK-DISP-01** — dispatcher agent with tool list
- **TASK-DISP-02** — auto-apply threshold + queue-for-review
- **TASK-DISP-03** — UI suggestions column + one-click approval
- **TASK-DISP-04** — cancellation reflow
- **TASK-DISP-05** — metrics dashboard (% auto-applied, overrides)

---

## phase_ai_tech_assistant anchors
- **TASK-TA-01** — `tech.photoQuote` capability
- **TASK-TA-02** — `tech.notesToInvoice` capability
- **TASK-TA-03** — pgvector KB + garage-door seed (~200 docs)
- **TASK-TA-04** — mobile UI hooks for both capabilities
- **TASK-TA-05** — acceptance/override telemetry

---

## phase_ai_collections anchors
- **TASK-COL-01** — AR aging query + BullMQ scheduler
- **TASK-COL-02** — `collections.draft` capability (3 tones)
- **TASK-COL-03** — review queue UI
- **TASK-COL-04** — Stripe payment retry orchestration
- **TASK-COL-05** — per-franchisee config

---

## phase_franchisor_console anchors
- **TASK-FC-01** — network dashboard (aggregated metrics)
- **TASK-FC-02** — franchisee drill-down with impersonation
- **TASK-FC-03** — audit log viewer v2 (if needed beyond TEN-08)
- **TASK-FC-04** — franchisee onboarding wizard (multi-step)
- **TASK-FC-05** — pricebook template publisher
- **TASK-FC-06** — agreement authoring UI

---

## phase_corporate_hub_redesign (phase 14)

Replaces the franchise tenancy with a single corporate parent and many
branches, each run by a local manager paid base + commission. See
`phases/phase_corporate_hub_redesign_GATE.md`.

### TASK-CHR-01: Migration 0016 — corporate / branches / comp plans / commission ledger

**Phase:** corporate_hub_redesign
**Depends on:** all phase 2–13 schemas in place
**Estimated LOC:** 600

Create migration `0016_corporate_hub_redesign.sql`:
new tables `corporate` (single row; columns include
`default_margin_pct` (default 60), `min_margin_pct` (default 20),
`max_margin_pct` (default 200) — bounds used by SQB-07 margin engine),
`branches`, `branch_managers`, `comp_plans`,
`user_comp_assignments`, `commission_ledger`, `pricebook_suggestions`.
Data migration copies `franchisors` → `corporate` (one row), every
`franchisees` row → `branches`, `franchisee_admin` memberships →
`branch_managers`, then `ALTER TABLE … RENAME COLUMN franchisee_id TO
branch_id` on every business table inside the same tx. Drops
`pricebook_overrides`, `franchise_agreements`, `royalty_rules`,
`royalty_statements`. Reversible down migration. RLS rewritten to the
two-policy template (`_corporate_admin`, `_scoped`).

**Acceptance criteria**
- [ ] CI gate runs `up → down → up` against a populated dev DB with no
  row-count delta on business tables
- [ ] Every table previously carrying `franchisee_id` now carries
  `branch_id` (verified by an introspection assertion)
- [ ] Every table with `branch_id` has both `_corporate_admin` and
  `_scoped` policies attached (introspection assertion)
- [ ] `docs/migrations/0016_pricebook_overrides_snapshot.csv` is written
  on up

---

### TASK-CHR-02: RequestScope + plugin rewrite

**Phase:** corporate_hub_redesign
**Depends on:** CHR-01
**Estimated LOC:** 300

`RequestScope` collapses to `corporate | branch`. `requestScopePlugin`
resolves the scope against the new role enum: `corporate_admin`,
`manager`, `csr`, `tech`. `withScope` sets `app.role` and `app.branch_id`
only; old `app.franchisor_id` / `app.franchisee_id` keys are removed.
Impersonation routes deleted (corporate is natively cross-branch).

**Acceptance criteria**
- [ ] All `request.requireScope()` call sites compile against the new
  union (`pnpm -r typecheck` exits 0)
- [ ] Live security test asserts `app.branch_id` is set on every
  authenticated DB tx (sampled assertion)
- [ ] `serviceai.impersonate` cookie + `/impersonate/*` endpoints
  removed

---

### TASK-CHR-03: API rename sweep

**Phase:** corporate_hub_redesign
**Depends on:** CHR-02
**Estimated LOC:** 400

Body fields, query params, route segments, and ts-rest contracts updated
from `franchisee` → `branch`. Cross-tenant probe behaviour preserved
(404, not 403). Live security suite renamed and rewritten for the new
role matrix.

**Acceptance criteria**
- [ ] `pnpm -r test` exits 0
- [ ] No reference to `franchisee` or `franchisor` remains in
  `apps/api/src` or `packages/contracts/src` (grep gate in CI)

---

### TASK-CHR-04: Comp plan schema + Zod validators

**Phase:** corporate_hub_redesign
**Depends on:** CHR-01
**Estimated LOC:** 350

Three rule kinds for v1: `flat_percent_of_invoice_paid`,
`tiered_percent_of_invoice_paid`, `flat_percent_of_quote_committed`.
Zod schema validates the `commission_rules` JSONB on read and write.
Property-based tests cover each rule across boundary cases.

**Acceptance criteria**
- [ ] 100% of rule kinds have a passing property test
- [ ] Invalid rule JSON returns `400 INVALID_COMP_PLAN` with
  field-level Zod errors

---

### TASK-CHR-05: Commission engine

**Phase:** corporate_hub_redesign
**Depends on:** CHR-04
**Estimated LOC:** 500

Pure projector `computeCommission(tx, userId, periodLabel)`. Transition
functions `onInvoicePaid(invoiceId, tx)` and `onQuoteCommitted(quoteId,
tx)` write `commission_ledger` rows. Idempotent on
`(user_id, source_kind, source_id)` unique index. Frozen
`rule_snapshot` JSONB captures the plan at calc time.

**Acceptance criteria**
- [ ] Property tests cover: empty period, single invoice, ten invoices,
  refund reverses, manual adjustment, plan change mid-period
- [ ] Replaying `onInvoicePaid` for the same invoice does not duplicate
  the ledger row
- [ ] Integration test against the live demo seed asserts a known
  invoice → ledger amount

---

### TASK-CHR-06: /corporate web routes

**Phase:** corporate_hub_redesign
**Depends on:** CHR-02, CHR-04
**Estimated LOC:** 800

New routes:
- `/corporate/branches` — list with status, manager, monthly revenue,
  monthly commission paid out
- `/corporate/branches/new` — 3-step wizard (legal name + address +
  timezone → Twilio number → assign manager)
- `/corporate/branches/:id` — detail with manager history, comp plan
  assignment, branch status toggle, audit log filter
- `/corporate/managers` — manager directory + comp plan assignment
- `/corporate/comp-plans` — list, create, edit

Old `/franchisor/*` routes deleted in the same commit.

**Acceptance criteria**
- [ ] Non-corporate roles hit `notFound()` on every `/corporate/*` route
- [ ] Playwright spec walks the new-branch wizard end-to-end

---

### TASK-CHR-07: /branch manager dashboard

**Phase:** corporate_hub_redesign
**Depends on:** CHR-05
**Estimated LOC:** 400

`/branch` route renders for `manager` only. Tiles: branch revenue MTD,
AR open, jobs in flight, projected commission. Pipeline card of
committed quotes pending invoice. Recent jobs list. Manager cannot see
sibling-branch data.

**Acceptance criteria**
- [ ] Manager-A sees their data only — branch-B probe returns 404
- [ ] Projected commission matches `computeCommission` for the manager
  + current period

---

### TASK-CHR-08: Royalty engine removal + single Stripe account

**Phase:** corporate_hub_redesign
**Depends on:** CHR-01
**Estimated LOC:** -1200 (net deletion)

Drop `franchise_agreements`, `royalty_rules`, `royalty_statements`.
Delete `/api/v1/royalty/*` routes. Delete Stripe Connect onboarding +
account linking flows. PaymentIntent creation switches to a single
corporate Stripe account; `application_fee_amount` removed.

**Acceptance criteria**
- [ ] Net LOC deletion ≥ 1000
- [ ] Stripe webhook handler still processes
  `payment_intent.succeeded` correctly under the new single-account
  config
- [ ] No test still imports a royalty type

---

### TASK-CHR-09: Pricebook override removal

**Phase:** corporate_hub_redesign
**Depends on:** CHR-01
**Estimated LOC:** 200

Drop `pricebook_overrides` (snapshot written by CHR-01). New
`pricebook_suggestions` table + a manager UI form "Suggest price
change" that drops a row for corporate review. Pricebook is now a
single corporate-owned, single-resolved view.

**Acceptance criteria**
- [ ] Pricebook read path no longer JOINs against overrides
- [ ] Manager can submit a suggestion; corporate sees it in
  `/corporate/pricebook/suggestions`

---

### TASK-CHR-10: AI prompt / tool updates

**Phase:** corporate_hub_redesign
**Depends on:** CHR-03
**Estimated LOC:** 250

CSR voice tools, dispatcher tools, tech assistant prompts, and
collections drafts all updated from `franchiseeId` → `branchId`.
`branches.brand_voice jsonb` column added; migration copies prior
`franchisees.brand_voice` over. Recorded voice fixtures regenerated.

**Acceptance criteria**
- [ ] Voice integration suite (`live-csr-voice.test.ts`) exits 0 against
  regenerated fixtures
- [ ] No `franchiseeId` literal in `packages/ai/prompts/**`

---

### TASK-CHR-11: Docs sweep

**Phase:** corporate_hub_redesign
**Depends on:** all prior CHR tasks
**Estimated LOC:** 400

`docs/ARCHITECTURE.md` rewritten for the corporate hub model with a
preserved appendix for the pre-2026-05 franchise model. `CLAUDE.md`
rewritten (project identity, tenancy rule, guardrail defaults). New
top entry in `docs/EVOLUTION.md`. `docs/PHASES.md` strikes through
`phase_royalty_engine` and `phase_franchisor_console` with redirect
notes pointing to CHR.

---

### TASK-CHR-12: Adversarial audit pass

**Phase:** corporate_hub_redesign
**Depends on:** CHR-11
**Estimated LOC:** 100 (remediations)

Run the adversarial-auditor subagent (manual invocation per
`project_servicetitan_autonomous_loop` memory — no run-build.sh loop).
Output is `phases/phase_corporate_hub_redesign_AUDIT_1.md`. Any
BLOCKERS go through one correction cycle; MINORs land in TECH_DEBT.

---

## phase_supplier_quote_bridge (phase 15)

Adds live supplier quoting against BC AI Agent under the Elevated Doors
BC customer account. See `phases/phase_supplier_quote_bridge_GATE.md`.

### TASK-SQB-01: Migration 0017 — quote tables + margin overrides + RLS + seed

**Phase:** supplier_quote_bridge
**Depends on:** CHR-01 (`branch_id` exists + `corporate.default_margin_pct` /
`corporate.min_margin_pct` / `corporate.max_margin_pct` columns), CHR-04
(comp plans exist)
**Estimated LOC:** 450

New tables: `suppliers`, `margin_overrides` (corporate-scoped, keyed by BC
`itemCategoryCode`), `quotes`, `quote_line_items` (with
`applied_margin_pct`, `applied_margin_source`, `margin_override_pct?`,
`margin_override_reason?` columns), `quote_status_log`. Two-policy RLS.
Seed: one `suppliers` row pointing at BC AI Agent staging with the
Elevated Doors BC customer code; one `margin_overrides` row per door-type
category seeded from OPENDC's existing splits (`ALUMINIUM`, `ROLLUP`,
`LIFTMASTER`).

---

### TASK-SQB-02: packages/suppliers — provider interface + mock

**Phase:** supplier_quote_bridge
**Depends on:** none
**Estimated LOC:** 400

New workspace package exporting `SupplierProvider` interface,
`ProviderRegistry`, and a `MockProvider` for tests. Strict TS types for
`PriceResult` and `CommitResult`.

---

### TASK-SQB-03: BC AI Agent — external_api_keys table + key mgmt

**Phase:** supplier_quote_bridge
**Depends on:** none (lives in the BC AI Agent repo)
**Estimated LOC:** 350

In `bc-ai-agent`: Alembic migration adds `external_api_keys` table
(argon2id hashed, scoped to a single `supplier_account_code` per key).
Admin-only `/api/external-keys` CRUD. Plaintext shown once at create.
Rate limit defaults: 600 rpm per key.

---

### TASK-SQB-04: BC AI Agent — POST /api/external/price-items

**Phase:** supplier_quote_bridge
**Depends on:** SQB-03
**Estimated LOC:** 450

Wraps existing BC SalesPriceLists resolution. 60 s Redis cache per
`(customer, sku)`. Returns `unit_price_cents` + `unit_cost_cents`.
p95 < 600 ms under perf test.

---

### TASK-SQB-05: BC AI Agent — POST /api/external/quotes

**Phase:** supplier_quote_bridge
**Depends on:** SQB-03, SQB-04
**Estimated LOC:** 500

Wraps `bc_quote_service` to create a real BC sales quote. Idempotent on
`external_quote_id`. Returns `supplier_quote_ref` (SQ-XXXXXX). 10×
concurrent commit test asserts exactly one BC document created.

---

### TASK-SQB-06: BcAiAgentProvider

**Phase:** supplier_quote_bridge
**Depends on:** SQB-02, SQB-04, SQB-05
**Estimated LOC:** 350

First real `SupplierProvider` impl in `packages/suppliers`. HTTPS
client with retry-on-network-error, idempotency-key propagation, p95
budget enforcement, Sentry tags. Recorded-fixture integration test +
live-staging smoke test.

---

### TASK-SQB-07: Service.AI quote routes + status machine + margin engine + commission write

**Phase:** supplier_quote_bridge
**Depends on:** SQB-01, SQB-02, CHR-05
**Estimated LOC:** 900

ts-rest contracts for `/api/v1/quotes/*`. Five routes per the gate:
create, price, commit, void, read+list. `quote-status-machine.ts` per
the pattern in `job-status-machine.ts`.

**Margin engine**: `resolveSellingPrice({ unitCostCents, itemCategory,
lineOverridePct? }, tx)` applies the resolution order line override →
`margin_overrides` (category) → `corporate.default_margin_pct`. Formula
is multiplicative (`price = cost * (1 + pct/100)`). `unit_cost_cents` is
re-fetched from the supplier provider on every price call — never
trusted from the client. Bounds enforced against
`corporate.min_margin_pct` / `corporate.max_margin_pct`; out-of-range →
422 `MARGIN_OUT_OF_BOUNDS`. Per-line `margin_override_pct` requires
`margin_override_reason` (server validation) and a manager+
role; every override writes an `audit_log` row. Quote commit freezes
`applied_margin_pct` so later edits to `margin_overrides` do not
retroactively change committed totals.

**Commission write**: on `priced → committed`, write the
`commission_ledger` row for the `closer_user_id` if their active comp
plan has a `flat_percent_of_quote_committed` rule (atomic with the
status transition). On `committed → void`, write the balancing reversal
row.

**Acceptance criteria**
- [ ] Property tests for the three-level resolution order, including
  ties (override = 0 should still win over default)
- [ ] Property tests for bounds enforcement on both line and category
  rows
- [ ] Integration test asserts cost cannot be manipulated by a forged
  client body (server ignores client-sent cost)
- [ ] Integration test asserts that editing a category override does
  NOT change the totals on a previously committed quote

---

### TASK-SQB-08: /quotes/new live web UI + corporate margin settings

**Phase:** supplier_quote_bridge
**Depends on:** SQB-07
**Estimated LOC:** 1200

**`/quotes/new`**: pricebook-aware line picker, 300 ms debounced
re-price, in-flight spinner + cancellation, subtotal/tax/total updates
in place, manager-only margin pill per line + overall margin, per-line
override popover (new % + required reason) for manager+
roles only, manager commission preview, sticky "Send to supplier"
success → SQ-XXXXXX banner.

**`/corporate/settings/margins`** (corporate_admin only): default margin
% input + category overrides table (BC `itemCategoryCode` autocomplete +
margin %, with add / edit / delete). Read-only min/max bounds visible
to corporate_admin; editable only by platform_admin via a separate
collapsed section.

**Acceptance criteria**
- [ ] CSR role at `/quotes/new` does not see margin or commission
- [ ] Manager role can edit a per-line override; missing reason →
  inline form error, no API call
- [ ] Override out of bounds → user-facing toast referencing the
  configured min/max
- [ ] Editing a category override and reloading an in-progress draft
  re-prices live; an already-committed quote does not move

---

### TASK-SQB-09: /tech/jobs/:id/quote/new mobile view

**Phase:** supplier_quote_bridge
**Depends on:** SQB-08
**Estimated LOC:** 500

Mobile-first reskin of the same component. Bottom-sheet SKU picker.
Offline cache for `priceItems` with a "stale" badge; commit is blocked
offline and queued.

---

### TASK-SQB-10: AI CSR tools quoteConfigurator + commitQuote

**Phase:** supplier_quote_bridge
**Depends on:** SQB-06, SQB-07
**Estimated LOC:** 400

New voice tools in `packages/ai/prompts/csr/` + dispatcher tool list.
Guardrail defaults added to `CLAUDE.md`. `ai_actions` row per commit
with confidence + supplier ref.

---

### TASK-SQB-11: Observability wiring

**Phase:** supplier_quote_bridge
**Depends on:** SQB-06
**Estimated LOC:** 200

Request-ID propagation Service.AI → BC AI Agent → BC. Audit-log row on
every supplier call. Sentry tags. pino redaction confirmed by a CI grep
gate against logs.

---

### TASK-SQB-12: Perf + idempotency + commission stress

**Phase:** supplier_quote_bridge
**Depends on:** SQB-08, SQB-09, SQB-10
**Estimated LOC:** 350

k6 scenario for 20-CSR live re-price + commit. Idempotency stress (10×
concurrent commit, network-drop simulation). Commission-ledger reversal
test on void. Semgrep clean.

---

### TASK-SQB-13: Docs

**Phase:** supplier_quote_bridge
**Depends on:** all prior SQB tasks
**Estimated LOC:** 500

`docs/api/supplier-quote-bridge.md` with sequence diagrams,
`ARCHITECTURE.md` updates, `CLAUDE.md` updates on both repos,
`docs/LESSONS.md` reserved entry.
