# Audit: phase_foundation — Run 3

**Verdict:** FAIL
**Blockers:** 2
**Date:** 2026-04-21
**Commit:** c4f6425d

---

## What was verified from Audit 2 fixes

All four claimed fixes from the corrector were inspected and three are genuine:

- **B1 fixed:** `next.config.ts` now wraps with `withSentryConfig` and disables auto-instrumentation (`autoInstrumentAppDirectory: false`, `autoInstrumentServerFunctions: false`, `autoInstrumentMiddleware: false`). `not-found.tsx` and `error.tsx` are present. `pnpm -r build` exits 0. `apps/web/.next/` is populated with all expected artifacts. `apps/api/dist/` and `apps/voice/dist/` also exist.
- **B2 fixed:** `packages/contracts/src/__tests__/echo.test.ts:161` now uses `toHaveProperty([200])` and casts with `as unknown as z.ZodTypeAny`. `pnpm -r typecheck` exits 0 across all 8 packages.
- **B4 fixed:** `apps/api/src/app.ts` imports `{ logger }` from `./logger.js` and passes it as `loggerInstance` to Fastify in the production path (when `opts.logger === undefined`). `pino-pretty@13.1.3` is now in `apps/api/package.json` devDependencies and is installed.

B3 is partially fixed — details in BLOCKER B2 below.

---

## Test results (clean)

```
pnpm -r typecheck   → exits 0 (all 8 packages)
pnpm -r test        → exits 0 (111 tests: 48 API, 20 contracts, 19 DB, 16 web, 11 voice)
pnpm -r build       → exits 0 (web .next/, api dist/, voice dist/ all present)
pnpm -r lint        → exits 0
```

---

## Blockers (must fix before gate)

### B1. `pnpm audit --audit-level=high` exits 1 — HIGH CVE never addressed

**Gate section:** "Security Baseline" under "Must Pass (BLOCKERS — any failure rejects the gate)", line 142 of `phase_foundation_GATE.md`.

**Evidence:**
```
rollup@3.29.5 — GHSA-mw96-cpmx-2vgc: Arbitrary file write via path traversal
Path: apps/web > @sentry/nextjs@8.55.1 > @rollup/plugin-commonjs@28.0.1 > rollup@3.29.5
      apps/web > @sentry/nextjs@8.55.1 > rollup@3.29.5
4 vulnerabilities found — Severity: 3 moderate | 1 high
Exit code: 1
```

The root `package.json` has no `pnpm.overrides` section. The corrector classified this as W1 in Audit 2 but it sits inside the "Must Pass (BLOCKERS)" section of the gate at line 142 — not in a "should fix" section. The gate criterion is: `pnpm audit --audit-level=high` exits 0. It does not.

**Fix direction:** Add to root `package.json`:
```json
"pnpm": {
  "overrides": {
    "rollup": ">=3.30.0"
  }
}
```
Then run `pnpm install` to regenerate the lockfile.

---

### B2. ts-rest client declared but never called — response shape mismatch does not cause compile error

**Gate criterion** (phase_foundation_GATE.md, line 76-77): "Web uses the ts-rest typed client; a type error in the response shape causes a TypeScript compile error. Verification: Introduce a deliberate shape mismatch in the client consumer; `pnpm -r typecheck` exits non-zero."

**File:** `apps/web/src/app/page.tsx:22,52`

**Evidence:** The corrector wired `initClient(echoContract, ...)` and then wrote:
```ts
void (apiClient satisfies typeof apiClient);
```
This expression is a tautology. `satisfies typeof apiClient` always holds because both sides are the same type — it is logically equivalent to `void apiClient`. The client is never called (no `apiClient.echo(...)` invocation), so the TypeScript compiler never type-checks the response value against any typed variable.

Empirical test: if `EchoResponseSchema` is changed to require an additional field (e.g., `z.object({ ok: z.literal(true), data: z.object({ echo: z.string(), foo: z.string() }) })`), `pnpm -r typecheck` exits 0. No error surfaces in `apps/web` because no code consumes the client's return value.

The gate criterion is structurally unmet. B3 from Audit 2 was about the client not being wired at all; this is about the wiring being a no-op for type enforcement.

**Fix direction:** Replace the tautological `satisfies` line with a typed constant that actually consumes the client's response type. For example:

```ts
// Declare a typed variable that would fail to compile if the response schema changes.
// This variable is never used at runtime but forces the compiler to check the shape.
type EchoResponse = Awaited<ReturnType<typeof apiClient.echo>>
// If the contract adds a required field, the type-guard below will fail to compile.
const _typeGuard = (_r: EchoResponse & { status: 200 }) => {
  const _echo: string = _r.body.data.echo; // fails if echo is no longer a string
  void _echo;
};
void _typeGuard;
```

Or, more simply, add a type assertion on the response shape:
```ts
type _AssertEchoBody = Awaited<ReturnType<typeof apiClient.echo>> extends
  { status: 200; body: { ok: true; data: { echo: string } } } | { status: 400; body: unknown }
  ? true : never;
const _: _AssertEchoBody = true; // compile error if contract drifts
```

---

## Warnings (should fix but not blocking)

### W1. `tests/foundation/` package still not in pnpm workspace

`pnpm-workspace.yaml` lists only `apps/*` and `packages/*`. The 132 tests in `tests/foundation/` (which cover CI config, observability, DO spec, Docker Compose) are not included in `pnpm -r test`. They pass when run manually (`cd tests/foundation && pnpm test` → 132 passed) but are invisible to the automated test run and to CI.

**Fix direction:** Add `'tests/*'` to `pnpm-workspace.yaml`.

### W2. Docker Compose app services have no healthcheck definitions

`web`, `api`, and `voice` containers lack `healthcheck:` stanzas. They will show as "running" but never "healthy" in `docker compose ps`. Gate verification says "healthy or running" which technically passes but is weaker than intended.

### W3. Sentry Fastify error handler not registered

`app.ts` initialises Sentry via `import './sentry.js'` but never calls `Sentry.setupFastifyErrorHandler(app)`. Gate criterion: "An uncaught error thrown in `apps/api` creates a Sentry event with request context (URL, method, request ID)." Request context will not be attached to Sentry events without the error handler.

### W4. Graceful shutdown has no integration test

`apps/api/src/index.ts` registers SIGTERM/SIGINT handlers. Gate criterion: "Integration test sends SIGTERM while a slow request is in-flight; process exits 0 after request completes." No such test exists in `apps/api/src/__tests__/`.

### W5. API echo route does not use `@ts-rest/fastify` server handler

`@ts-rest/fastify` is in `apps/api/package.json` dependencies but is never imported. The echo route uses raw Fastify + local Zod parsing. Changes to the contract schema do not cause the API's TypeScript compile to fail.

### W6. `.do/app.yaml` uses placeholder GitHub repo

All three services reference `repo: your-org/service-ai`. Auto-deploy cannot work with a placeholder.

### W7. `pnpm -r build` wall time baseline not recorded

Gate requires: `time pnpm -r build` output recorded as baseline. Not present anywhere in the phase artifacts.

---

## Verified criteria (passing)

- `pnpm -r typecheck` exits 0 — all 8 packages.
- `pnpm -r build` exits 0 — `apps/web/.next/`, `apps/api/dist/`, `apps/voice/dist/` all exist. First Load JS = 103 kB (baseline recorded here for future gates).
- `pnpm -r test` exits 0 — 111 tests across 5 active packages.
- `pnpm -r lint` exits 0.
- `apps/web/next.config.ts` wraps with `withSentryConfig` and disables all auto-instrumentation.
- `apps/web/src/app/not-found.tsx` and `apps/web/src/app/error.tsx` both present.
- `apps/api/src/app.ts` imports `logger` from `logger.ts` and passes it as `loggerInstance` to Fastify in the production path (when no test override is provided).
- `pino-pretty` is in `apps/api/package.json` devDependencies and is installed.
- `apps/web/package.json` has `@service-ai/contracts` and `@ts-rest/core` as dependencies.
- `apps/web/src/app/page.tsx` imports from both `@service-ai/contracts` and `@ts-rest/core`.
- `packages/contracts/src/__tests__/echo.test.ts` uses correct `[200]` array accessor syntax — no numeric-key TS error.
- `packages/db/vitest.config.ts` excludes `dist/` (confirmed passing 19/19 tests).
- No secrets in git history. `.env` is gitignored.
- `packages/contracts/src/echo.ts` exists with `EchoInputSchema`, `EchoResponseSchema`, and `echoContract` (POST /api/v1/echo).
- All packages have `"strict": true` via `tsconfig.base.json`.
- Fastify plugins registered: sensible, helmet, cors, rate-limit, compress — all present.
- Structured JSON logs with `reqId` field.
- Voice service: WebSocket at `/call` handshakes correctly, echo ping→pong latency test passes.
- Migrations stored as SQL files in `packages/db/migrations/`.
- `.github/workflows/ci.yml` exists with typecheck/lint/test/build jobs, triggers on push and pull_request.
- `README.md` contains prerequisites, docker compose quick-start, per-service commands, env var reference, rollback procedure, and test instructions.
- `docs/ARCHITECTURE.md` covers three-service topology, package structure, local vs DO parity.
- Port mappings in `docker-compose.yml` match spec (3000, 3001, 8080, 5434, 6381).
- Pino redact configuration covers authorization headers and cookies.
- Axiom and Sentry disabled gracefully when env vars unset.

---

## Verdict

FAIL. Two blockers remain.

B1 is a gate-listed security criterion (`pnpm audit --audit-level=high` exits 0) that was misclassified as a warning in Audit 2 but is unambiguously in the "Must Pass (BLOCKERS)" section of the gate at line 142. The rollup HIGH CVE has not been addressed in any commit since Audit 1. Adding a pnpm override is a 3-line fix.

B2 is a new finding. The corrector's B3 fix wired `initClient(echoContract, ...)` into `page.tsx` but the client is never called — only declared. The expression `void (apiClient satisfies typeof apiClient)` is a tautology that provides zero type enforcement on the contract response shape. The gate criterion explicitly requires that a deliberate response shape mismatch causes a TypeScript compile error in the web consumer. It does not. This requires the fix to add at least one typed reference to the client's response type so the compiler would catch contract drift.

All other previously-reported blockers (B1-B4 from Audit 2) are genuinely fixed and verified.
