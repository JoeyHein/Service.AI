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
