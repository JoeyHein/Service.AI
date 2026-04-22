# Correction: phase_foundation — Cycle 1

**Date:** 2026-04-21
**Corrector:** Autonomous Corrector
**Audit addressed:** phases/phase_foundation_AUDIT_1.md
**Commit:** 8acbbaf6f3806c8df2a9a57213ac551a9c38dc0a

---

## Summary

Two of the six AUDIT_1 blockers were addressed in this cycle. The remaining four blockers (B1, B2, B5, B6) and all five MAJOR issues were deferred to Correction Cycle 2. The two fixes in this cycle unblocked `pnpm -r test` from its hard failures: 19/19 DB tests now pass and `packages/ai`, `packages/auth`, `packages/ui` no longer crash the test runner.

---

## Fixed in this cycle

### B3 — FIXED: DB tests fail (14/19) due to vitest picking up `dist/` files

**Original issue:** `packages/db/vitest.config.ts` had no `include` or `exclude` patterns. Vitest 4.1.5 discovered test files in both `src/` (TypeScript source) and `dist/src/` (compiled output). When running compiled tests, `__dirname` resolved to `/workspace/packages/db/dist/src/__tests__/`, making `PACKAGE_ROOT` equal to `dist/` — a path that contains no `migrations/` subdirectory. All 14 tests that resolved migration file paths via `__dirname` failed with `ENOENT`.

**Root cause:** CLAUDE.md requires `include: ['src/**/*.test.ts']` and `exclude: ['dist/**', 'node_modules/**']` in every `vitest.config.ts` for packages that compile to `dist/`. `packages/db/vitest.config.ts` was missing both directives.

**Fix:** Added `include: ['src/**/*.test.ts']` and `exclude: ['dist/**', 'node_modules/**']` to `packages/db/vitest.config.ts`.

**Regression test:** The fix is self-evidencing: `pnpm --filter @service-ai/db test` must exit 0 with 19/19 tests passing. The 14 previously-failing path-resolution tests now pass because Vitest only runs the TypeScript source copy, whose `__dirname` resolves to `src/__tests__/` and whose `../../` relative traversal correctly reaches the package root.

**Files changed:** `packages/db/vitest.config.ts`

---

### B4 — FIXED: `packages/ai`, `packages/auth`, `packages/ui` test scripts fail with `vitest: not found`

**Original issue:** Three stub packages declared `"test": "vitest run"` in their `package.json` scripts but did not install `vitest` in `devDependencies`. Running `pnpm -r test` failed with `sh: 1: vitest: not found` for all three, causing the overall `pnpm -r test` to exit non-zero.

**Root cause:** Stub packages scaffolded with a placeholder test command that references a binary that is not installed. CLAUDE.md specifies that stub packages with no tests must use `"test": "echo 'No tests in stub package' && exit 0"` and must never declare `"test": "vitest run"` without vitest in devDependencies.

**Fix:** Changed the `test` script in all three packages from `"vitest run"` to `"echo 'No tests in stub package'"`:
- `packages/ai/package.json`
- `packages/auth/package.json`
- `packages/ui/package.json`

**Regression test:** `pnpm -r test` must exit 0 without any `vitest: not found` errors. These stub packages now emit the expected message and exit 0, allowing the recursive test run to complete.

**Files changed:** `packages/ai/package.json`, `packages/auth/package.json`, `packages/ui/package.json`

---

## Deferred to next cycle

The following AUDIT_1 blockers were not addressed in this cycle. Each was carried forward to Correction Cycle 2 (`c4f6425d`):

### B1 — DEFERRED: Web production build fails
`apps/web/next.config.ts` is missing the `withSentryConfig` wrapper required for `@sentry/nextjs` App Router compatibility. `pnpm --filter @service-ai/web build` exits 1 on every run. Fix requires wrapping the Next.js config and adding App Router error boundary pages.

### B2 — DEFERRED: TypeScript typecheck fails
`packages/contracts/src/__tests__/echo.test.ts:161` uses `echoContract.echo.responses[200]` with a bare numeric literal key, which ts-rest's type system rejects. `pnpm -r typecheck` exits 2. Fix requires changing `toHaveProperty(200)` calls to `toHaveProperty([200])` and casting `echoContract.echo.responses[200]` via `as unknown as z.ZodTypeAny`.

### B5 — DEFERRED: `pino-pretty` not installed; Axiom logger crashes when `AXIOM_TOKEN` is set
`apps/api/src/logger.ts:35` references `pino-pretty` as a transport target but the package is absent from `apps/api/package.json`. Wiring `logger.ts` with `AXIOM_TOKEN` set would throw `Error: unable to determine transport target for "pino-pretty"`. Additionally, `logger.ts` is not imported by `app.ts` — the Axiom transport is dead on arrival. Fix requires installing `pino-pretty` as a devDependency and importing `logger.ts` in `buildApp()`.

### B6 — DEFERRED: Web app does not use the ts-rest typed client
`apps/web/package.json` has no dependency on `@service-ai/contracts` or `@ts-rest/core`. `page.tsx` uses a plain `fetch()` call and has no type enforcement against the contract. Fix requires adding the workspace dependency and replacing the `fetch()` call with a typed `initClient` call.

---

## MAJOR issues — all deferred

All five MAJOR issues from AUDIT_1 were deferred and did not change state in this cycle:

| ID | Issue | Disposition |
|----|-------|-------------|
| M1 | Docker Compose `web`/`api`/`voice` have no `healthcheck` stanzas | Deferred — addressed later in AUDIT_3 scope |
| M2 | No graceful shutdown integration test (SIGTERM in-flight test) | Deferred — downgraded to warning in subsequent audits; not required for gate pass |
| M3 | Web page calls non-existent `/api/v1/health`; API only exposes `/healthz` | Deferred — resolved in B6 fix by replacing health fetch with typed echo call |
| M4 | `pnpm audit --audit-level=high` exits 1 — rollup GHSA-mw96-cpmx-2vgc HIGH CVE | Deferred — fixed in commit `05729076` via `pnpm.overrides` |
| M5 | `tests/foundation/` not in pnpm workspace; 132 tests excluded from `pnpm -r test` | Deferred — remained a warning through gate approval; tests run independently |

---

## Remaining open after this cycle

Four blockers remain open and are carried to the next correction cycle:

1. **B1** — `pnpm -r build` exits 1 (web Sentry/App Router conflict)
2. **B2** — `pnpm -r typecheck` exits 2 (contracts test numeric key error)
3. **B5** — Axiom logger transport broken; `pino-pretty` missing
4. **B6** — Web app uses plain `fetch()` with no ts-rest type enforcement

**Verification after this cycle:**
- `pnpm -r test` → exits 0 (111 tests: 45 API, 20 contracts, 19 DB, 16 web, 11 voice)
- `pnpm --filter @service-ai/db test` → 19/19 pass (was 5/19 for in-process tests; 14 compiled-dist failures eliminated)
- `pnpm -r typecheck` → still exits 2 (B2 not yet fixed)
- `pnpm -r build` → still exits 1 (B1 not yet fixed)
