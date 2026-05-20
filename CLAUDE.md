# CLAUDE.md — Service.AI Project Conventions

This file is read by every agent at the start of every session. Keep it current.

## Project identity

Service.AI is an **AI-native field service platform** for trades, launched on **garage doors**, designed as a **corporate hub-and-spoke** operation from day one. One corporate parent (the hub). Many **branches** (the spokes). Each branch is run by a **local W2 manager** paid **base salary + commission**. No independent franchisees, no royalty agreements, no per-branch Stripe accounts. First production customer: Elevated Doors, run as a corporate-operated brand. Vertical slicing is mandatory — every phase ships a working end-to-end path.

Architecturally ERP-agnostic at the core, with supplier integration routed through a provider abstraction (`packages/suppliers`). The first concrete provider, `BcAiAgentProvider`, talks to OPENDC's BC AI Agent, which fronts Microsoft Business Central under the Elevated Doors customer account. Service.AI never speaks BC OData directly — only through a `SupplierProvider`.

**Done-definition for v1**: Elevated Doors runs one branch end-to-end on Service.AI for 30 continuous days.

> **Model change note (2026-05).** This project shipped its first 13 phases on a franchise tenancy model (platform → franchisor → franchisee → location). Phase 14 (`phase_corporate_hub_redesign`, CHR-01..12) replaced that with the corporate hub-and-spoke model described here. Code, schema, and docs are now the corporate model; the franchise model is preserved for historical reference in `docs/ARCHITECTURE.md` Appendix A.
>
> **Phase 15 note (2026-05).** Phase 15 (`phase_supplier_quote_bridge`, SQB-01..13) added the live supplier quote bridge: `packages/suppliers` provider abstraction, `apps/api/src/quote-routes.ts` + `margin-engine.ts` + `quote-status-machine.ts`, `/corporate/settings/margins` + `/quotes/new` + tech PWA `/tech/jobs/:id/quote/new` UIs, AI CSR tools `quoteConfigurator` + `commitQuote`, and migration `0017_supplier_quote_bridge.sql`. Detailed reference: `docs/api/supplier-quote-bridge.md`.
>
> **Phase 16 note (2026-05).** Phase 16 (`phase_quote_order_conversion`, QOC-01..08) closes the SQB loop: a CSR/tech clicks "Customer accepted" → `POST /api/v1/quotes/:id/accept` transitions the quote to `accepted` and best-effort calls `provider.convertQuoteToOrder`, which hits BC AI Agent's new `POST /api/external/quotes/:id/convert-to-order` endpoint and stamps `SO-XXXXXX` onto the Service.AI quote row. Migration `0018_quote_order_conversion.sql` adds `supplier_order_ref`, `supplier_order_id`, `ordered_at` to `quotes`. Same idempotency key (`external_quote_id`) as commit; same per-key in-process lock at BC AI Agent.
>
> **Phase 17 note (2026-05).** Phase 17 (`phase_customer_quote_acceptance`, CQA-01..07) adds the customer-facing close: `POST /quotes/:id/share` mints a signed link; the public `quotes[token]/accept` page lets a homeowner accept and pay a deposit (Stripe Elements). Public token-gated routes in `apps/api/src/public-quote-routes.ts` run **outside RequestScope**; the operator + public accept paths share `runOrderConversion` so they can't drift. Migration `0019_customer_quote_acceptance.sql` adds accept-token + deposit columns to `quotes` and a deposit policy to `corporate`. Detailed reference: `docs/api/customer-acceptance.md`.

## Customer-facing surfaces (CQA, load-bearing)

Public, token-gated routes (the accept link, deposit, public PDF) live in
`apps/api/src/public-quote-routes.ts` and are registered **outside**
RequestScope — the 32-byte path token is the auth, there is no session.
Rules:
- **Never expose cost or margin** on a public surface. The public quote view
  uses an explicit whitelist select (no `SELECT *`); a field-leak test
  guards it. Same rule for the customer PDF.
- CSRF on public POSTs = `Origin`/`Referer` allowlist (`WEB_ORIGIN`) +
  JSON-only, NOT cookie double-submit (there is no cookie).
- Customer-originated writes set `actor_user_id = NULL` (FK to `users`) and
  record `customerRef` in `audit_log.metadata`.
- Deposit amounts come from the server-frozen `quotes.deposit_amount_cents`,
  never request input (same cost-trust rule as quote pricing).

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
| Payments | Stripe (single corporate account) |
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
│   ├── web/          Next.js 15 office UI + dispatch board + /corporate hub + /branch manager dashboard
│   ├── api/          Fastify API (corporate-routes.ts, branch-routes.ts, commission-engine.ts, ...)
│   └── voice/        Fastify WS voice server
├── packages/
│   ├── db/           Drizzle schema + migrations (0016 corporate hub redesign, 0017 supplier quote bridge, 0018 quote order conversion)
│   ├── contracts/    Zod schemas + ts-rest route definitions (incl. comp-plans.ts, quotes.ts, margins.ts)
│   ├── ai/           Multi-provider LLM router + prompt library + RAG client
│   ├── auth/         Better Auth config + middleware
│   ├── suppliers/    SupplierProvider abstraction (MockSupplierProvider, BcAiAgentProvider, ProviderRegistry)
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

Owner-side web route groups: `apps/web/src/app/(app)/corporate/*` (branches, managers, comp-plans, pricebook-suggestions) and `apps/web/src/app/(app)/branch/*` (manager dashboard). The HQ "franchisor console" is gone; the catalog stays as a corporate-owned pricebook editor.

## Required patterns

### Tenancy (load-bearing — corporate hub model, CHR)

Canonical entry points:

- `requestScopePlugin` (`apps/api/src/request-scope.ts`) — Fastify
  plugin that attaches `request.scope`, `request.userId`, and a
  `request.requireScope()` helper to every authenticated request.
  Resolves the scope from Better Auth's session + the `memberships`
  table. `RequestScope` is a 2-variant discriminated union
  (`corporate` / `branch`) — pattern-match on `scope.type`, never
  access fields that may not exist on the variant. **No impersonation**:
  corporate sees every branch natively; branch-scoped roles are pinned
  to one branch and cannot read sibling-branch data even with a forged
  request body.
- `withScope(db, scope, fn)` (`@service-ai/db`) — runs `fn(tx)` inside
  a transaction with `app.role`, `app.branch_id`, and `app.user_id` set
  via `set_config(..., true)` (transaction-local, auto-clear on
  commit/rollback). Every query that reads a tenant-scoped table should
  run inside this, so Postgres RLS policies fire. The corporate variant
  passes an empty string for `branchId`; the policy migration uses
  `nullif(..., '')::uuid` so empty strings coerce to NULL and only the
  `_corporate_admin` policy permits the read.

Required defence-in-depth combo for every tenant-scoped read:

1. `scope = req.requireScope()` — 401/403 before any DB work
2. App-layer `WHERE` that matches the scope (e.g.
   `eq(jobs.branchId, scope.branchId)` for branch scope). Required
   because the dev docker Postgres connects as a superuser that bypasses
   RLS; production DO Postgres connects as a non-superuser and RLS does
   its job, but both paths must behave identically.
3. `withScope(db, scope, tx => tx.select()...)` — RLS enforces the same
   filter at the DB layer if the app-layer WHERE is ever forgotten.

Rules:
- `branch_id` is resolved from `request.scope`, **never** from
  request input. Body fields like `{ branchId }` that cross-reference
  the scope must validate (e.g. `target.branchId === scope.branchId`).
- Every tenant-scoped table has `ROW LEVEL SECURITY ENABLED` +
  `FORCE ROW LEVEL SECURITY` + **two** named policies per table
  (`<table>_corporate_admin` + `<table>_scoped`). New migrations
  that add tenant tables must add policies in the same commit — see
  migration `0016_corporate_hub_redesign.sql` for the template.
- Cross-tenant probes return `404 NOT_FOUND` (never `403`) so the
  caller cannot infer the existence of a branch they shouldn't see.

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

### Supplier integration (SQB, load-bearing)

Live quotes against an external supplier go through `packages/suppliers`.
Business code (routes, AI tools, web) never calls a supplier's HTTP surface
directly — it goes through a `SupplierProvider`:

- `SupplierProvider` interface: three core operations — `priceItems`
  (read, idempotent, sub-second p95 budget), `commitQuote` (idempotent
  on `externalQuoteId`), and `convertQuoteToOrder` (idempotent on the
  same `externalQuoteId`, best-effort from the route handler). Plus
  optional `voidQuote`.
- `BcAiAgentProvider` — first production impl. Native fetch, 50/200/800ms
  backoff on 5xx + 429, sends `X-Service-AI-Key` (bcrypt-hashed,
  plaintext-shown-once) and `X-Request-ID` (Service.AI's Fastify request
  id, threaded end-to-end web → Service.AI → BC AI Agent → BC OData).
- `MockSupplierProvider` — tests and the early prototype path.
- `ProviderRegistry` — keyed by `provider_kind`, cached per `supplierId`.

Required invariants:

1. **Cost is never trusted from the client.** Every price call re-fetches
   `unit_cost_cents` from the provider. Verified by
   `live-quote-routes.test.ts::test_cost_forgery`.
2. **Margin engine resolution** (`apps/api/src/margin-engine.ts`): line
   override → category override → `corporate.default_margin_pct`. Multiplicative
   formula (`price = cost × (1 + pct/100)`). Bounds enforced against
   `corporate.min_margin_pct` / `max_margin_pct`. A line override of 0% wins
   over the default — zero is a valid choice. `applied_margin_pct` is frozen
   at commit; later category-override edits do not rewrite committed totals.
3. **Override authorization**: `marginOverridePct` requires
   `marginOverrideReason` (else 422 `OVERRIDE_REASON_REQUIRED`) and manager+
   role (csr/tech/dispatcher get 403 `OVERRIDE_NOT_PERMITTED`).
4. **Idempotency** is layered: the Service.AI `/quotes/:id/commit`
   `Idempotency-Key` header flows through as the request body's
   `idempotencyKey`, becomes `externalQuoteId` at the provider boundary,
   and lands as `external_quote_commits.external_quote_id` (UNIQUE
   constraint + per-key in-process lock at BC AI Agent). 10× concurrent
   commits collapse to one BC document + one `commission_ledger` row.
5. **Status state machine**: `quote-status-machine.ts` follows the pattern
   from `### Status state machines` above. Commit transitions status
   `draft|priced → committed` and runs `onQuoteCommitted(tx, ...)` to write
   the `commission_ledger` row in the same transaction. Void runs
   `reverseQuoteCommitted(tx, ...)` to write the balancing −cents row with
   `source_kind=manual_adjustment`, `source_id=reverse:quote_committed:<quoteId>`.
6. **Secret hygiene**: `X-Service-AI-Key` is in the Pino redact list
   (`apps/api/src/logger.ts`) in five shapes — inbound headers, outbound
   headers, generic `apiKey`/`api_key` fields, camelCase, arbitrary
   bracket-keyed parent. Verified by `sqb-11-redaction.test.ts`. Semgrep
   rules in `.semgrep.yml` block: raw key in `console.log`, fs writes
   from `packages/suppliers`, body-derived `branch_id`, direct `fetch` to
   BC AI Agent's external surface from outside `packages/suppliers`.

Detailed reference (sequences, latency budgets, idempotency map):
`docs/api/supplier-quote-bridge.md`.

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
- Every AI-originated action (`ai_actions` row) has a confidence score and respects the guardrails defaults below. The per-branch guardrails surface (corporate-overridable per branch) is a v1.5 follow-up; static defaults are the source of truth in v1.
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
- No reintroduction of impersonation. Corporate sees every branch natively — there is no header, cookie, or banner that narrows a corporate session to a single branch.
- No direct `fetch` (or `axios`, etc.) to BC AI Agent's `/api/external/*` surface from outside `packages/suppliers`. All supplier traffic goes through a `SupplierProvider`. Semgrep-enforced via `.semgrep.yml`.
- No client-supplied `unit_cost_cents` on quote line writes. Cost comes from the provider on every price call, never from the request body.
- No raw `X-Service-AI-Key` in logs or error messages. Pino redaction covers it; do not log request/response bodies that bypass that redact list.

## Multi-tenancy rule (strict)

Every tenant-scoped table carries:
- `branch_id` (NOT NULL on row types that only make sense inside a
  branch; the only tenant scope key in the corporate hub model)
- `created_at`, `updated_at`

Every SELECT/UPDATE/DELETE against that table:
- Runs inside `withScope(db, scope, fn)` from `@service-ai/db` so
  RLS policies fire
- Adds an app-layer WHERE matching `request.scope` as defence in depth
- Fails closed: if `request.scope` is null, the handler returns 401
  before the query runs (`req.requireScope()` throws)

RLS template: two policies per table — `<table>_corporate_admin` (permissive
for `app.role = 'corporate_admin'`) plus `<table>_scoped` (matches
`branch_id = nullif(app.branch_id, '')::uuid`). See migration
`0016_corporate_hub_redesign.sql` for the canonical pattern.

## AI guardrail defaults (per branch — corporate-overridable; not yet UI-exposed in v1)

| Capability | Default confidence | Default dollar cap | Default undo window |
|---|---|---|---|
| csr.bookJob | 0.80 | n/a | 15 min |
| csr.quoteConfigurator | 0.70 | n/a | n/a (replayable) |
| csr.commitQuote | 0.90 | $5,000 | 5 min |
| dispatcher.autoAssign | 0.80 | n/a | 5 min |
| tech.photoQuote | 0.75 | $500 | n/a (tech confirms) |
| collections.sendDraft | 0.90 | n/a | 30 min |

The `franchisees.ai_guardrails` JSONB column went away with the table in CHR-01. The AI runtime currently uses these static defaults for every branch. Per-branch overrides will land behind a `/corporate/branches/:id/ai-guardrails` surface in v1.5; until then, only a `corporate_admin` can tighten or relax them and only via a code change. The values in the table are floors — managers cannot raise their own thresholds.

## Lessons learned

See `docs/LESSONS.md` — updated by the evolver after each phase. **Read it before starting any new phase.**

## Escalation

If any agent genuinely cannot proceed (tests can't be made to pass after 3 attempts, environment is broken, criteria are impossible, an architectural decision needs human judgment) — write to the appropriate `phases/*_BLOCKED.md` file and stop. Do not fake progress. Do not silently drop scope.

## First-customer specifics (Elevated Doors)

- Elevated Doors is a **corporate-operated brand** (not a franchisee). Its branches are corporate-owned and run by W2 local managers on the standard base + commission comp plan.
- Legal entity name and brand config populated in seed per the actual onboarding artifacts.
- First branch: TBD at pilot start.
- Twilio number: provisioned on branch create through the `/corporate/branches/new` wizard, in the branch's area code.
- Pricebook: seeded by corporate as a single shared catalog; **no per-branch overrides in v1**. Managers submit `pricebook_suggestions` rows through `/branch/pricebook/suggest`; corporate reviews and approves at `/corporate/pricebook-suggestions`.
