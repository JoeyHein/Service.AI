# Correction: phase_foundation — Cycle 2

**Date:** 2026-04-21
**Corrector:** Autonomous Corrector
**Audit addressed:** phases/phase_foundation_AUDIT_2.md
**Prior correction:** phases/phase_foundation_CORRECTION_1.md (Cycle 1 — fixed B3/B4 from AUDIT_1)
**Commit with core fixes:** b7e5a11 (fix(foundation): AUDIT-2 correct build, typecheck, ts-rest client, observability wiring)

---

## Summary

All four AUDIT_2 blockers are resolved. The core fixes were committed at `c4f6425d`. This correction cycle additionally:
- Removed a staged working-tree regression (`app.ts:182`) introduced by the AUDIT_5 auditor's pre-commit hook test that was never cleaned up.
- Added missing regression tests for B1, B2, and a completeness gap in B4 that were absent from `c4f6425d`.

After this cycle: `pnpm -r test` exits 0 (237 tests: 49 API, 24 web, 21 contracts, 11 voice, 132 foundation). `pnpm -r typecheck` exits 0 across all 8 packages. `pnpm -r build` exits 0. `pnpm audit --audit-level=high` exits 0.

---

## B1 — FIXED: Web production build fails (`pnpm -r build` exits 1)

**Audit finding:** `@sentry/nextjs@8` injects a legacy Pages Router `<Html>` import into the 404/500 error pages during Next.js 15 App Router pre-rendering. `next.config.ts` was a bare config object with no `withSentryConfig` wrapper, which is required for Sentry's App Router support. Build failed with:
```
Error: <Html> should not be imported outside of pages/_document.
Error occurred prerendering page "/404"
```

**Root cause:** `withSentryConfig()` from `@sentry/nextjs` must wrap the exported Next.js config. Without it, Sentry 8's build plugin applies legacy Pages Router instrumentation unconditionally. The `autoInstrumentServerFunctions`, `autoInstrumentAppDirectory`, and `autoInstrumentMiddleware` flags also need to be set to `false` to suppress Pages Router API injection in App Router builds.

**Fix (`c4f6425d`):**
1. Imported `withSentryConfig` from `@sentry/nextjs` in `apps/web/next.config.ts`.
2. Wrapped the export: `export default withSentryConfig(nextConfig, { autoInstrumentServerFunctions: false, autoInstrumentAppDirectory: false, autoInstrumentMiddleware: false, sourcemaps: { disable: true }, disableLogger: true, ... })`.
3. Added `transpilePackages: ['@service-ai/contracts']` and a custom webpack `WorkspaceTsExtensionPlugin` to rewrite NodeNext `.js` → `.ts` extensions for workspace package imports (required for `@service-ai/contracts`'s NodeNext-style `./echo.js` imports to resolve correctly in Next.js's bundler).
4. Added `NODE_ENV=production` to the `build` script in `apps/web/package.json`.
5. Added `apps/web/src/app/not-found.tsx` and `apps/web/src/app/error.tsx` (App Router variants) so Next.js uses App Router error pages rather than falling through to the Pages Router `_error` chain.

**Verification:** `pnpm --filter @service-ai/web build` exits 0. `apps/web/.next/` exists with server, static, and cache subdirectories. Next.js reports 4 static pages prerendered.

**Regression test added (this cycle):** `apps/web/src/__tests__/structure.test.ts` — `AUDIT-2 / B1 regression / Sentry next.config wrapping` suite (4 tests):
- `next.config.ts imports withSentryConfig from @sentry/nextjs`
- `next.config.ts wraps the exported config with withSentryConfig() (not a bare NextConfig)`
- `Sentry autoInstrumentServerFunctions is disabled to prevent Pages Router injection`
- `Sentry autoInstrumentAppDirectory is disabled`

**Files changed:** `apps/web/next.config.ts`, `apps/web/package.json`, `apps/web/src/app/not-found.tsx`, `apps/web/src/app/error.tsx`, `apps/web/src/__tests__/structure.test.ts`

---

## B2 — FIXED: TypeScript typecheck fails (`pnpm -r typecheck` exits 2)

**Audit finding:** `packages/contracts/src/__tests__/echo.test.ts:161` used `toHaveProperty(200)` with a bare numeric literal. ts-rest's `AppRoute.responses` type is `Record<string | (string | number)[], ZodTypeAny>` — TypeScript rejects `number` as a direct key, producing:
```
error TS2345: Argument of type 'number' is not assignable to parameter of type 'string | (string | number)[]'
```
Additionally, `echoContract.echo.responses[200]` without a cast could not be assigned to `z.ZodTypeAny`.

**Root cause:** The test was written with a plain numeric literal in `toHaveProperty()` and without a type cast on the index access, both of which ts-rest's response map type rejects.

**Fix (`c4f6425d`):**
1. Changed `toHaveProperty(200)` → `toHaveProperty([200])` at line 161. Array notation satisfies `(string | number)[]`.
2. Changed all occurrences of `echoContract.echo.responses[200]` to use `echoContract.echo.responses[200] as unknown as z.ZodTypeAny` (lines 166, 177, 185, 198). The `as unknown` intermediate cast is the correct escape hatch — it does not widen the value type to `any` but crosses the incompatible index type boundary safely.

**Verification:** `pnpm --filter @service-ai/contracts typecheck` exits 0. `pnpm -r typecheck` exits 0 across all 8 packages.

**Regression test added (this cycle):** `packages/contracts/src/__tests__/echo.test.ts` — `AUDIT-2 / B2 regression / ts-rest responses numeric key` suite (1 test):
- `echoContract.echo.responses[200] is accessible without a TypeScript error` — documents the `[200]` array notation and `as unknown as z.ZodTypeAny` cast pattern, and executes the cast to confirm the retrieved schema is callable.

**Files changed:** `packages/contracts/src/__tests__/echo.test.ts`

---

## B3 — FIXED: Web app does not use the ts-rest typed client

**Audit finding:** `apps/web/package.json` had no dependency on `@service-ai/contracts` or `@ts-rest/core`. `apps/web/src/app/page.tsx` used a plain `fetch('/api/v1/health')` call to a non-existent endpoint (the API exposes `/healthz`, not `/api/v1/health`). A contract schema change would cause zero TypeScript errors in the web app.

**Root cause:** The web scaffold was created without wiring the contracts package or the ts-rest client. AUDIT_1 deferred this as B6; AUDIT_2 re-elevated it as B3 since it directly violates a named gate criterion.

**Fix (`c4f6425d`):**
1. Added `"@service-ai/contracts": "workspace:*"` and `"@ts-rest/core": "^3"` to `dependencies` in `apps/web/package.json`.
2. Added `"main": "./src/index.ts"` and `"exports": { ".": "./src/index.ts" }` to `packages/contracts/package.json` so Next.js resolves the TypeScript source directly.
3. Rewrote `apps/web/src/app/page.tsx` to build a typed client via `initClient(echoContract, { baseUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001', baseHeaders: {} })` and call `apiClient.echo({ body: { message: 'ping' } })`. `result.body.data.echo` is accessed with full TypeScript enforcement — renaming `echo` in the contract schema causes a compile error in `page.tsx`.

**Verification:** `pnpm --filter @service-ai/web typecheck` exits 0. Introducing a schema mismatch in `EchoResponseSchema` produces a TS error in `page.tsx` before any runtime execution.

**Regression test:** `apps/web/src/__tests__/structure.test.ts` — `AUDIT-2 / B3 regression / ts-rest typed client` suite (4 tests, added in `c4f6425d`):
- `@service-ai/contracts is listed as a dependency in package.json`
- `@ts-rest/core is listed as a dependency in package.json`
- `page.tsx imports @service-ai/contracts`
- `page.tsx imports from @ts-rest/core`

**Files changed:** `apps/web/package.json`, `apps/web/src/app/page.tsx`, `packages/contracts/package.json`

---

## B4 — FIXED: Axiom integration dead; `logger.ts` orphaned; `pino-pretty` missing

**Audit finding:** Two separate failures:
1. `apps/api/src/app.ts` did not import `logger.ts`. Fastify was configured with `{ level: 'info' }` (built-in logger). The `@axiomhq/pino` transport in `logger.ts` was never activated — no logs reached Axiom regardless of whether `AXIOM_TOKEN` was set. Gate criterion "a log line appears in Axiom within 10s" was structurally unachievable.
2. `apps/api/src/logger.ts:35` referenced `pino-pretty` as a transport target for local console output, but `pino-pretty` was absent from `apps/api/package.json`. Any invocation with `AXIOM_TOKEN` set would throw: `Error: unable to determine transport target for "pino-pretty"`.

**Root cause (orphaned logger):** `logger.ts` was scaffolded but never imported in `buildApp()`. CLAUDE.md rule: "Any logger module created must be immediately imported and wired into the framework instance — a logger file with zero imports elsewhere is a defect."

**Root cause (pino-pretty):** The `logger.ts` transport config included `pino-pretty` for local human-readable output but the package was never added to `devDependencies`.

**Fix (`c4f6425d`):**
1. Added `import { logger } from './logger.js';` to `apps/api/src/app.ts`.
2. Replaced the unconditional `Fastify({ ...commonOpts, logger: opts.logger as boolean })` call with a branch:
   - Test path (when `opts.logger !== undefined`): `Fastify({ ...commonOpts, logger: opts.logger as boolean })`.
   - Production path (default): `Fastify({ ...commonOpts, loggerInstance: logger })`. Fastify 5 requires `loggerInstance` when passing a pre-built pino instance; passing it via `logger` throws a runtime error.
   - Applied `as App` cast to normalise the union return type so callers see a uniform `FastifyInstance` regardless of which branch was taken.
3. Added `"pino-pretty": "^13.1.3"` to `devDependencies` in `apps/api/package.json`.

**Verification:** `buildApp()` (no opts) boots cleanly; `app.log.info` is callable; `pino-pretty` installed in `apps/api/node_modules`.

**Regression tests (`c4f6425d` + this cycle):** `apps/api/src/__tests__/health.test.ts` — `AUDIT-2 / B4 regression / logger wiring` suite (4 tests):
- `buildApp() without opts.logger boots without throwing` — validates `loggerInstance` path does not crash Fastify
- `buildApp() without opts.logger exposes a functioning log object` — `app.log.info/error/warn` all callable
- `buildApp({ logger: false }) suppresses logging without error` — test helper path still works
- `pino-pretty is declared as a devDependency in apps/api/package.json` *(added this cycle)* — guards against accidental removal of the `pino-pretty` dependency that would re-introduce the transport crash

**Files changed:** `apps/api/src/app.ts`, `apps/api/package.json`, `apps/api/src/__tests__/health.test.ts`

---

## Staged regression removed (not from AUDIT_2)

**Issue:** During AUDIT_5's pre-commit hook verification, the auditor added `const x: number = "this is a string";` at `apps/api/src/app.ts:182` as a live test that the hook blocks the commit. The change was staged but never committed or reverted. It caused `pnpm -r typecheck`, `pnpm -r lint`, and `pnpm -r build` to fail — confirmed by `phase_foundation_TEST_RESULTS_2.md`.

**Fix:** Removed line 182. `apps/api/src/app.ts` is back to its gate-approved state.

**Files changed:** `apps/api/src/app.ts`

---

## Test counts after this cycle

| Suite | Before this cycle | After this cycle | Delta |
|---|---|---|---|
| `apps/api` | 48 | **49** | +1 (pino-pretty dep) |
| `apps/web` | 20 | **24** | +4 (B1 Sentry suite) |
| `packages/contracts` | 20 | **21** | +1 (B2 numeric key) |
| `apps/voice` | 11 | 11 | — |
| `tests/foundation` | 132 | 132 | — |
| **Total** | **231** | **237** | **+6** |

---

## Verification commands

```bash
# All tests pass
pnpm -r test                    # exits 0, 237 tests

# Typecheck clean across all 8 packages
pnpm -r typecheck               # exits 0

# Lint clean
pnpm -r lint                    # exits 0

# Build artifacts produced
pnpm -r build                   # exits 0; apps/web/.next, apps/api/dist, apps/voice/dist

# Zero high/critical CVEs
pnpm audit --audit-level=high   # exits 0
```

---

## Open items (not AUDIT_2 scope, identified by AUDIT_5)

| ID | Issue |
|----|-------|
| AUDIT5-B1 | Coverage tooling (`@vitest/coverage-v8`) absent — ≥80% coverage gate unverifiable |
| AUDIT5-B2 | Graceful shutdown integration test missing (SIGTERM in-flight) |
| AUDIT5-B3 | `pnpm db:migrate` fails from repo root — needs root `package.json` script |
| AUDIT5-M1 | Homepage calls `POST /api/v1/echo` not `GET /api/v1/health`; coverage test is a false positive on JSDoc comment text |
| AUDIT5-M2 | Husky `prepare` script missing — hooks inactive on fresh clone |
