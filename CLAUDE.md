# CLAUDE.md — Service.AI Project Conventions

This file is read by every agent at the start of every session. Keep it current.

## Project identity

Service.AI is an **AI-native field service platform** for trades, launched on **garage doors**, designed as a **franchise platform** from day one. First production customer: Elevated Doors (US). Vertical slicing is mandatory — every phase ships a working end-to-end path.

Architecturally ERP-agnostic. An external portal may later connect this to Microsoft Business Central. We do not integrate with BC directly.

**Done-definition for v1**: Elevated Doors runs one territory end-to-end on Service.AI for 30 continuous days.

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict mode everywhere) |
| Monorepo | pnpm workspaces + Turborepo |
| API | Fastify 5 + Zod + ts-rest for shared contracts |
| Web | Next.js 15 (App Router) + React 19 + Tailwind + shadcn/ui |
| Mobile | PWA (v1); React Native (v2, out of scope) |
| Voice | Fastify WS + Twilio Media Streams + Deepgram + ElevenLabs |
| Database | Postgres 16 (DO Managed) + Drizzle ORM + pgvector |
| Queue/cache | Redis 7 (DO Managed) + BullMQ |
| Auth | Better Auth (self-hosted) |
| Payments | Stripe Connect Standard |
| Maps | Google Maps (Places + Geocoding + Distance Matrix) |
| AI | Multi-provider router (Claude via Anthropic SDK, Grok via xAI SDK) |
| Vision | Claude Sonnet 4.6 |
| Hosting | DigitalOcean App Platform (3 services: web, api, voice) + Managed Postgres + Managed Redis + Spaces |
| Observability | Axiom (logs/traces) + Sentry (errors) |
| Testing | Vitest (unit + integration) + Playwright (E2E) + k6 (perf) + Semgrep (SAST) |

## File and folder layout

```
servicetitan-clone/
├── apps/
│   ├── web/          Next.js 15 office UI + dispatch board + franchisor console
│   ├── api/          Fastify API
│   └── voice/        Fastify WS voice server
├── packages/
│   ├── db/           Drizzle schema + migrations
│   ├── contracts/    Zod schemas + ts-rest route definitions
│   ├── ai/           Multi-provider LLM router + prompt library + RAG client
│   ├── auth/         Better Auth config + middleware
│   └── ui/           shadcn component library
├── tests/
│   ├── e2e/          Playwright specs, organized by phase
│   └── perf/         k6 load scenarios, organized by phase
├── tools/            scripts, seeds, migrations tooling
├── .claude/          agent definitions + settings
├── .do/              DigitalOcean App Platform spec
├── docs/             PRD, ARCHITECTURE, PHASES, TASKS, TEST_STRATEGY, EVOLUTION, LESSONS, TECH_DEBT
├── phases/           per-phase gates, audits, corrections, reviews, evolutions
├── scripts/          plan.sh, launch.sh, run-build.sh, status.sh, notify.sh
└── logs/             build run logs and notifications
```

## Required patterns

### Tenancy (load-bearing)

Canonical entry points implemented in phase_tenancy_franchise:

- `requestScopePlugin` (`apps/api/src/request-scope.ts`) — Fastify
  plugin that attaches `request.scope`, `request.userId`,
  `request.impersonation`, and a `request.requireScope()` helper to
  every authenticated request. Resolves the scope from Better Auth's
  session + the `memberships` table + optional impersonation header
  or `serviceai.impersonate` cookie. `RequestScope` is a discriminated
  union (`platform` / `franchisor` / `franchisee`) — pattern-match on
  `scope.type`, never access fields that may not exist on the variant.
- `withScope(db, scope, fn)` (`@service-ai/db`) — runs `fn(tx)` inside
  a transaction with `app.role`, `app.franchisor_id`, `app.franchisee_id`
  set via `set_config(..., true)` (transaction-local, auto-clear on
  commit/rollback). Every query that reads a tenant-scoped table should
  run inside this, so Postgres RLS policies fire.

Required defence-in-depth combo for every tenant-scoped read:

1. `scope = req.requireScope()` — 401/403 before any DB work
2. App-layer `WHERE` that matches the scope (e.g.
   `eq(franchisees.franchisor_id, scope.franchisorId)`). Required
   because the dev docker Postgres connects as a superuser that bypasses
   RLS; production DO Postgres connects as a non-superuser and RLS does
   its job, but both paths must behave identically.
3. `withScope(db, scope, tx => tx.select()...)` — RLS enforces the same
   filter at the DB layer if the app-layer WHERE is ever forgotten.

Rules:
- `franchisee_id` is resolved from `request.scope`, **never** from
  request input. Body fields like `{ franchiseeId }` that cross-reference
  the scope must validate (e.g. `target.franchisorId ===
  scope.franchisorId`) — see `apps/api/src/invites.ts#resolveTarget`
  and `apps/api/src/can-invite.ts` for the pattern.
- Every tenant-scoped table has `ROW LEVEL SECURITY ENABLED` +
  `FORCE ROW LEVEL SECURITY` + three named policies per table
  (`_platform_admin` / `_franchisor_admin` / `_scoped`). New migrations
  that add tenant tables must add policies in the same commit — see
  migration 0003 for the template.
- Franchisor cross-tenant access requires either the
  `X-Impersonate-Franchisee` header or the `serviceai.impersonate`
  cookie (header wins). The plugin validates and writes exactly one
  `audit_log` row per impersonated request. UI flow: POST
  `/impersonate/start` to set the cookie, POST `/impersonate/stop` to
  clear.

### API
- Every endpoint registered through ts-rest; contract lives in `packages/contracts`.
- Every endpoint returns `{ ok: true, data }` or `{ ok: false, error: { code, message, details? } }`.
- Every POST supports `Idempotency-Key` (Redis-backed 24h TTL).
- Every endpoint has Zod input validation.
- Rate limit policy declared per endpoint (default 60 rpm per user).
- Cross-tenant access always returns `404 NOT_FOUND` (never `403`) so
  the caller cannot infer the existence of a row they shouldn't see.
  See `apps/api/src/customers-routes.ts` + `jobs-routes.ts` for the
  canonical pattern.

### Status state machines (load-bearing for lifecycle entities)

When an entity has a status column with structured transitions
(jobs, invoices, bookings, …), follow the pattern proven in
`apps/api/src/job-status-machine.ts`:

1. Encode the matrix as a pure function module that both the API and
   the web UI import. Web renders only `validTransitionsFrom(current)`
   buttons; API calls `canTransition(from, to)` to validate.
2. Illegal moves return `409 INVALID_TRANSITION` with `{ from, to }`
   in the message.
3. The status update and any accompanying log row (`*_status_log`)
   run in a single `withScope()` transaction so state and history
   cannot drift.
4. Lifecycle timestamps (`actual_start`, `actual_end`, etc.) are
   populated by the transition handler, not by separate PATCH calls.
5. DB-level CHECKs for the matrix are deliberately skipped — they
   can't encode the procedural edge cases (e.g. "unschedule" edges,
   conditional approvals). The app owns correctness; the DB just
   enforces the enum.

### Database
- Every migration is reversible (has `up` + `down`) and idempotent.
- Every write operation is wrapped in a transaction.
- Every foreign key has an index.
- SQL string concatenation is forbidden. Use Drizzle query builder or prepared parameters.

### Testing (per endpoint)
- 401 test (unauthenticated)
- 403 test (wrong tenant / wrong role)
- 400 test (invalid input, structured error returned)
- Happy-path test
- Edge-case test

### AI
- Every AI call goes through `packages/ai`'s router (never direct SDK use in app code).
- Every AI call persists to `ai_conversations` + `ai_messages`.
- Every AI-originated action (`ai_actions` row) has a confidence score, and the action respects the franchisee's configured guardrails.
- Prompts live in `packages/ai/prompts/` — not inline strings in business code.

### Commit messages (Conventional Commits)
- `feat(<phase>): <TASK-ID> <summary>`
- `fix(<phase>): <AUDIT-ID> <summary>`
- `test(<phase>): <TASK-ID> <summary>`
- `chore(evolution): after <phase>`
- `chore: <thing>` for scaffolding

### Code
- Every public function has a JSDoc with purpose, params, returns, and edge cases.
- No comments describing what the code does — names should do that. Comments explain why.
- No `any` types without a line comment explaining the choice.
- Pure functions wherever possible. Side effects are named and documented.

### Testing infrastructure
- Every `vitest.config.ts` in a package that builds to `dist/` must include `include: ['src/**/*.test.ts']` and `exclude: ['dist/**', 'node_modules/**']` — otherwise Vitest runs compiled test files from `dist/` with broken path resolution.
- Stub packages with no tests yet must use `"test": "echo 'No tests in stub package' && exit 0"`. Never declare `"test": "vitest run"` without vitest in devDependencies.

### Observability wiring
- Any logger module created must be immediately imported and wired into the framework instance — a logger file with zero imports elsewhere is a defect.
- Next.js App Router apps using Sentry must include `src/app/global-error.tsx` (Client Component, renders own `<html>`/`<body>`, calls `Sentry.captureException`) so React render errors are captured.

### Security
- After adding any major dependency, run `pnpm audit --audit-level=high`. Pin transitive CVEs with `pnpm.overrides` in root `package.json` before merging. Document the CVE ID in a comment next to the override.

## Forbidden patterns

- No secrets in code or committed config. `.env` is gitignored; env vars via DO App Platform in deployed environments.
- No `console.log` in production paths — use pino via `packages/logger`.
- No commented-out code blocks. Delete or move to `docs/TECH_DEBT.md`.
- No `TODO` without a linked task ID.
- No skipping or disabling tests to make a build pass. Ever.
- No N+1 queries. List endpoints have a query-count assertion in integration tests.
- No direct DB access from `apps/web` or `apps/voice`. API is the only writer.
- No direct LLM SDK calls from business code. Route through `packages/ai`.
- No request-body-derived tenant IDs. Always use `request.scope`.

## Multi-tenancy rule (strict)

Every tenant-scoped table carries:
- `franchisee_id` (may be NULL only for rows that represent the
  franchisor / platform level; NOT NULL on row types that only make
  sense inside a franchisee)
- `location_id` (when applicable)
- `created_at`, `updated_at`

Every SELECT/UPDATE/DELETE against that table:
- Runs inside `withScope(db, scope, fn)` from `@service-ai/db` so
  RLS policies fire
- Adds an app-layer WHERE matching `request.scope` as defence in depth
- Fails closed: if `request.scope` is null, the handler returns 401
  before the query runs (`req.requireScope()` throws)

See `apps/api/src/invites.ts` and `apps/api/src/audit-log-routes.ts`
for the canonical pattern.

## AI guardrail defaults (per franchisee)

| Capability | Default confidence | Default dollar cap | Default undo window |
|---|---|---|---|
| csr.bookJob | 0.80 | n/a | 15 min |
| dispatcher.autoAssign | 0.80 | n/a | 5 min |
| tech.photoQuote | 0.75 | $500 | n/a (tech confirms) |
| collections.sendDraft | 0.90 | n/a | 30 min |

Franchisees can raise thresholds (more human gating) but not lower below the defaults without platform admin override.

## Lessons learned

See `docs/LESSONS.md` — updated by the evolver after each phase. **Read it before starting any new phase.**

## Escalation

If any agent genuinely cannot proceed (tests can't be made to pass after 3 attempts, environment is broken, criteria are impossible, an architectural decision needs human judgment) — write to the appropriate `phases/*_BLOCKED.md` file and stop. Do not fake progress. Do not silently drop scope.

## First-customer specifics (Elevated Doors)

- Legal entity name and brand config populated in seed per the actual onboarding artifacts (to be supplied before phase_franchisor_console).
- First territory: TBD at pilot start.
- Twilio number: provisioned automatically on franchisee signup in the correct area code.
- Pricebook: seeded from a template published by Elevated Doors HQ — platform_admin will load the HQ-blessed catalog before phase_pricebook completes.
