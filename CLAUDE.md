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
- Every tenant-scoped query includes `franchisee_id` (and when relevant `location_id`) in the WHERE clause.
- `tenant_id` is resolved from `request.scope`, **never** from request input.
- Postgres RLS is enabled as defense in depth with policies referencing session GUCs.
- Franchisor cross-tenant access requires the `X-Impersonate-Franchisee` header, validated, and writes a row to `audit_log`.

### API
- Every endpoint registered through ts-rest; contract lives in `packages/contracts`.
- Every endpoint returns `{ ok: true, data }` or `{ ok: false, error: { code, message, details? } }`.
- Every POST supports `Idempotency-Key` (Redis-backed 24h TTL).
- Every endpoint has Zod input validation.
- Rate limit policy declared per endpoint (default 60 rpm per user).

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
- `franchisee_id` (required; NOT NULL)
- `location_id` (when applicable)
- `created_at`, `updated_at`

Every SELECT/UPDATE/DELETE against that table:
- Uses `scopedQuery(request.scope)` from `packages/db` — or equivalent manual Drizzle with the scope check
- Fails closed: if `request.scope.franchisee_id` is missing and the caller isn't a platform admin, the query refuses to run

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
