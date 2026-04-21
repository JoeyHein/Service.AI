# Service.AI — Test Strategy

## 1. Philosophy

Tests are the specification. A feature is not done until its tests express the acceptance criteria and pass. The auditor will reject phases whose tests pass while the behavior is wrong — mocks of the thing under test are disqualifying.

## 2. Test levels

### Unit (Vitest)
- Pure functions, validators, rule evaluators, AI prompt composers, fee calculators.
- Zero network, zero DB. If a test needs a DB, it's not a unit test — upgrade it.
- Location: colocated as `*.test.ts` next to source.

### Integration (Vitest + real Postgres + real Redis)
- Every API endpoint: 401, 403, 400, happy path, at least two edge cases.
- Tenancy/IDOR: for every tenant-scoped endpoint, a test verifies that a user of franchisee A cannot read or write data of franchisee B.
- Database uses the compose Postgres (`postgres:5432` inside the network). Per-test schema or rollback-on-teardown.
- Location: `apps/<app>/test/integration/**/*.test.ts`.

### End-to-end (Playwright)
- Real browser, real API, real DB, seeded data.
- Covers the golden user journeys per phase.
- Always runs headless in CI; can run headed locally.
- Location: `tests/e2e/<phase>/*.spec.ts`.

### Performance (k6)
- Phase-specific load scenarios (dispatch board SSE, AI CSR call volume, webhook bursts).
- Budgets set per gate (e.g., board update p95 <500ms under 10 concurrent sessions).
- Location: `tests/perf/<phase>/*.js`.

### Security (custom Vitest suite + Semgrep + npm audit)
- IDOR, privilege escalation, input validation, SSRF, SQLi (shouldn't exist with Drizzle params, but test anyway), XSS in user-supplied content.
- Semgrep runs on CI with OWASP rules.
- Rotating weekly: scheduled DAST scan against staging (out of scope for build phases; documented).

## 3. Test data

- **No `foo`/`bar`.** Customers are "Marion Alvarez", "Carmichael LLC". Addresses are real US addresses (not real customers). Phone numbers from Twilio's magic-test ranges.
- **Seeds are the source of truth.** `pnpm seed` produces the dataset tests assume. E2E and integration both start from seed state.
- **Fixtures, not mocks**, where possible. Real Stripe test mode, real Twilio test numbers, real Deepgram with sandbox audio, real ElevenLabs with free tier.
- **Mock only external providers for unit tests**; integration hits the real sandboxes.

## 4. What "works" means per phase

| Phase | Works = |
|---|---|
| foundation | All 3 services deployed to staging, `/healthz` green, CI passes on main |
| tenancy_franchise | Cold-path IDOR tests pass; a franchisor admin can impersonate and it's audit-logged; inviting across 3 levels works end-to-end |
| customer_job | Tech can see their jobs, dispatcher can create and edit, tenant isolation proven by test |
| pricebook | HQ publishes, franchisee sees item, franchisee can override within floor/ceiling; blocked below floor with a helpful error |
| dispatch_board | 10 concurrent sessions see moves in <500ms; drag-drop is smooth on desktop + tablet |
| tech_mobile_pwa | E2E: tech completes a job offline, comes back online, sync succeeds, no lost writes; Lighthouse PWA score ≥90 |
| invoicing_stripe | Real Stripe test mode: payment collected, app fee applied, webhook updates invoice, receipt emailed |
| royalty_engine | Each rule type + combinations produce correct statements; reconciliation handles refunds and disputes; month-boundary correctness across TZs |
| ai_csr_voice | Synthesized test calls: bookJob intent ends with a job in DB and SMS sent; transfer-to-human works; call recording saved |
| ai_dispatcher | In a fixture scenario with 10 jobs + 3 techs, auto-applies ≥6 correctly, queues remainder with reasoning |
| ai_tech_assistant | Photo-to-quote returns ≥1 correct suggestion on a curated test set of 30 door photos; override telemetry is recorded |
| ai_collections | Drafts delivered on schedule, tone matches franchisee config; retry orchestration recovers a failed card in test mode |
| franchisor_console | Network dashboard aggregates correctly; onboarding wizard creates a new franchisee with Twilio number + Stripe Connect link + pricebook clone |

## 5. Performance baselines

- **API p95 latency**: <250ms for read endpoints, <800ms for writes that hit Stripe/Twilio/external. Enforced per endpoint by a test.
- **Database**: <50ms p95 on scoped reads; N+1 queries fail the auditor automatically (every multi-row list endpoint has a query-count assertion).
- **Dispatch board**: <500ms p95 for assignment propagation under 10 concurrent sessions.
- **Voice call first-token**: <1.5s from ASR commit to TTS first audio byte.
- **Bundle size**: web initial JS <250kb gzipped; a test fails CI if bundle exceeds budget by >10%.

## 6. Security test requirements

Every new API endpoint ships with:

1. **401 test** — unauthenticated request is rejected.
2. **403 test** — authenticated user from wrong franchisee/location is rejected. For resources that can exist across franchisees, the cross-tenant IDOR test must fetch by ID and verify either 404 (preferred) or 403.
3. **400 test** — invalid input produces a structured error with `code`, `message`, and field-level `details`.
4. **Happy-path test** — the normal flow succeeds.
5. **Edge-case test** — at least one test for an unusual-but-legal input (max-length strings, unicode, boundaries).

Plus: every role gets its own matrix test on the endpoint — if the endpoint accepts GET for a dispatcher, a tech's GET must be validated as allow or deny per spec.

## 7. AI-specific tests

### Deterministic
- Prompt composition (given context X, expect prompt string Y with X's values substituted)
- Tool call serialization
- Provider routing (given capability C, route to Claude vs. Grok per config)

### Non-deterministic (live-model) — tagged and run separately
- Capability quality: for `tech.photoQuote`, a curated set of 30 input photos each with 1-3 acceptable suggestion sets; pass = top suggestion is in the acceptable set
- Pass rate must be ≥80% for the phase to gate
- Non-deterministic tests run nightly in CI, not on every PR

### Cost budget
- Every capability has a token budget (input + output).
- Per-invocation cost recorded in `ai_messages`.
- Phase gate fails if median cost-per-invocation exceeds budget.

## 8. Continuous regression

- Every phase's test suite is **additively** merged into the global suite — phase 5 runs every test from phases 1-4 plus its own new ones.
- Global suite runs in CI on every PR. Must be green to merge.
- Flaky tests are explicitly tagged `flaky: <reason>` and tracked in `docs/TECH_DEBT.md`. The auditor may reject a phase for excessive flaky-test count.

## 9. Coverage

- **Target**: 80%+ on all business logic packages; 70%+ on app route handlers; 60%+ on UI components (focus on logic, not rendering).
- Coverage gaps in critical paths (auth, tenancy, payments, royalty) are rejected by the auditor regardless of overall %.

## 10. Running tests locally

```bash
pnpm test              # unit + integration for all packages
pnpm test:unit         # unit only
pnpm test:int          # integration (requires docker compose up)
pnpm test:e2e          # Playwright, requires all services running
pnpm test:perf         # k6 perf scenarios
pnpm test:ai           # non-deterministic AI tests (needs API keys)
pnpm test:security     # security-specific tests
```

## 11. What the auditor will actually check

Per `.claude/agents/auditor.md` — the auditor will:

1. Pull the branch and run the full suite
2. Inspect for: mocked-unit-under-test, skipped tests, hard-coded expected-to-pass values, tests whose names match features they don't actually exercise
3. Run the system and hit real endpoints with curl; compare vs. test assertions
4. Flag as BLOCKER: any test that passes while the observed behavior is wrong
5. Flag as MAJOR: significant coverage gaps on critical paths, missing IDOR tests, flaky tests without documented cause
6. Flag as MINOR: cosmetic test improvements, better assertions, test data realism

A phase does not pass the audit if it has any BLOCKERs or more than 3 MAJORs.
