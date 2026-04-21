# Test Results — phase_foundation — Run 1

**Date:** 2026-04-21  
**Runner:** test-runner agent (claude-sonnet-4-6)  
**Triggered by:** Orchestrator — post-build test gate  

---

## Executive Summary

| Category | Files | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|---|
| Foundation phase (fnd-*) | 5 | 132 | 132 | 0 | 0 |
| apps/api | 2 | 45 | 45 | 0 | 0 |
| apps/web | 1 | 16 | 16 | 0 | 0 |
| apps/voice | 1 | 11 | 11 | 0 | 0 |
| packages/db | 1 | 19 | 19 | 0 | 0 |
| packages/contracts | 1 | 20 | 20 | 0 | 0 |
| packages/ai | — | — | — | — | NO TEST FILES |
| packages/auth | — | — | — | — | NO TEST FILES |
| packages/ui | — | — | — | — | NO TEST FILES |
| **TOTAL** | **11** | **243** | **243** | **0** | **—** |

**Overall verdict:** All 243 tests pass. Two blocking issues found outside the test suite itself (typecheck failure in contracts, missing vitest dependency in ai/auth/ui). No E2E, performance, or SAST infrastructure configured for this phase.

---

## 1. Lint

**Command:** `pnpm -w run lint` (via Turborepo)  
**Result:** PASS — 8/8 packages clean  
**Duration:** ~33s  

Non-fatal warnings logged (do not block):
- All non-web packages: `[MODULE_TYPELESS_PACKAGE_JSON]` — root `package.json` lacks `"type": "module"`. ESLint still ran correctly.
- `apps/web`: Next.js `next-lint` plugin not detected in `eslint.config.js` (flat config format requires explicit plugin wiring). No errors or warnings on source files.

**No lint errors in any package.**

---

## 2. TypeScript Typecheck

**Command:** `pnpm -w run typecheck` (via Turborepo)  
**Result:** FAIL — 1 error  
**Duration:** ~9.5s  

### Failure

**Package:** `@service-ai/contracts`  
**File:** `packages/contracts/src/__tests__/echo.test.ts:161:56`  
**Error:**
```
error TS2345: Argument of type 'number' is not assignable to parameter of type 'string | (string | number)[]'.
```

**Root cause:** Indexing `echoContract.echo.responses[200]` with numeric literal `200`. ts-rest's generated `responses` type uses string or tuple index signatures; TypeScript rejects the bare `number` key at this access site. The runtime value is correct (tests pass), but the TypeScript type for property access must be `200 as const` or the variable must be typed as `z.ZodTypeAny` via a string index.

**Packages that passed:** api, web, voice, db, ai, auth, ui, contracts (all non-test source files pass).

---

## 3. Unit & Integration Tests

### 3.1 Foundation phase tests — `tests/foundation/`

**Runner:** Vitest v4.1.5 (own package with vitest v4)  
**Command:** `pnpm run test` in `tests/foundation/`  
**Duration:** 1.86s  
**Result:** PASS — 132/132

| File | Tests | Result |
|---|---|---|
| `fnd-01-monorepo.test.ts` | 50 | PASS |
| `fnd-07-ci.test.ts` | 22 | PASS |
| `fnd-08-observability.test.ts` | 17 | PASS |
| `fnd-09-do-spec.test.ts` | 15 | PASS |
| `fnd-10-compose.test.ts` | 28 | PASS |

Notable verifications confirmed passing:
- pnpm-workspace.yaml, turbo.json, tsconfig.base.json with `"strict": true`
- All 8 workspace dirs + package.json files with `@service-ai/*` scoped names
- All workspace tsconfigs extend root base; none override `strict: false`
- `.husky/pre-commit` exists, is executable, invokes lint and typecheck, no `|| true` suppression
- CI workflow (`ci.yml`) triggers on push+PR, has typecheck/lint/test/build jobs, uses pnpm with store caching
- No plaintext secrets in CI workflow
- Axiom + Sentry dependency declarations in all three apps
- `AXIOM_TOKEN` and `SENTRY_DSN` env-var guards in API source before enabling transports
- `pino` redact configuration covers the `authorization` header
- Sentry initialized in API and wired in Next.js
- `.do/app.yaml` present, all three services + Postgres + Redis declared, correct ports, auto-deploy branch, env var references
- `README.md` present with rollback section
- Docker Compose has all 5 services, correct non-default ports (5434, 6381), volume mounts for hot reload, shared network

### 3.2 apps/api — `src/__tests__/`

**Runner:** Vitest v3.2.4  
**Duration:** 16.90s  
**Result:** PASS — 45/45

| File | Tests | Result | Notes |
|---|---|---|---|
| `echo.test.ts` | 20 | PASS | POST /api/v1/echo — happy path, roundtrip fidelity, invalid input, envelope, edge cases |
| `health.test.ts` | 25 | PASS | GET /healthz — 200/503, DB/Redis mock failures, structured logging, request IDs, Helmet headers, CORS, 404 handling |

Observed structured pino JSON logs emitted during health tests — confirms logging pipeline is active.

### 3.3 apps/web — `src/__tests__/`

**Runner:** Vitest v3.2.4  
**Duration:** 13.96s  
**Result:** PASS — 16/16

| File | Tests | Result | Notes |
|---|---|---|---|
| `structure.test.ts` | 16 | PASS | Config files, App Router layout.tsx + page.tsx, Tailwind directives, shadcn components.json, "Service.AI" brand text, health endpoint reference, JSX tsconfig |

### 3.4 apps/voice — `src/__tests__/`

**Runner:** Vitest v3.2.4  
**Duration:** 8.12s  
**Result:** PASS — 11/11

| File | Tests | Result | Notes |
|---|---|---|---|
| `voice.test.ts` | 11 | PASS | GET /healthz, WebSocket /call handshake, ping→pong echo, latency <200ms, sequential messages, empty string edge case, concurrent clients |

### 3.5 packages/db — `src/__tests__/`

**Runner:** Vitest v4.1.5 (own version)  
**Duration:** 3.07s  
**Result:** PASS — 19/19

| File | Tests | Result | Notes |
|---|---|---|---|
| `health-checks.test.ts` | 19 | PASS | Schema exports, column presence, up/down migration SQL structure; **live DB integration**: insert/read-back, varchar(100)/(20) constraint enforcement, `checked_at` timestamp default |

The live integration tests hit the Postgres instance. All constraints and defaults verified against a real database.

### 3.6 packages/contracts — `src/__tests__/`

**Runner:** Vitest v3.2.4  
**Duration:** 3.19s  
**Result:** PASS — 20/20

| File | Tests | Result | Notes |
|---|---|---|---|
| `echo.test.ts` | 20 | PASS | File existence, re-exports, route definition (POST /api/v1/echo), body/response schema validation — accepts valid, rejects missing/wrong-typed/empty fields |

Note: All tests pass at runtime despite the TypeScript typecheck error at line 161 (numeric index). The `safeParse` call itself is structurally correct.

### 3.7 packages/ai, packages/auth, packages/ui

**Result:** TEST SCRIPT FAILS — `vitest: not found`

These three packages declare `"test": "vitest run"` in `package.json` but do not list `vitest` as a devDependency. Additionally, no `__tests__/` directory or test files exist in any of them — only a stub `src/index.ts`. The Turborepo `test` pipeline therefore fails for these 3 packages when invoked as `pnpm -w run test`.

**Impact:** No tests to pass or fail; the scripts themselves error. This is a configuration gap (empty package scripts pointing at an uninstalled binary), not a failing test.

---

## 4. E2E Tests (Playwright)

**Result:** NOT CONFIGURED  

No Playwright configuration file, no `tests/e2e/` spec files, and `playwright` is not present in any package.json. The gate document references E2E as a future concern; it is not required for phase_foundation completion per the gate criteria.

---

## 5. Performance Baseline (k6)

**Result:** NOT CONFIGURED  

No k6 scripts found in `tests/perf/` (directory does not exist). The gate document lists performance baselines as metrics to establish, not as pass/fail blockers for phase_foundation. Baselines will be captured when k6 infrastructure is wired.

---

## 6. Security Scan

### 6.1 `pnpm audit`

**Result:** 4 vulnerabilities — 1 HIGH, 3 MODERATE  
All findings are in **devDependencies only** (vitest/vite toolchain and Sentry bundler plugins). None affect production runtime.

| Severity | Package | Vulnerability | Path | Exploitable in Prod? |
|---|---|---|---|---|
| HIGH | `rollup@3.29.5` | Arbitrary File Write via Path Traversal (GHSA-mw96-cpmx-2vgc) | `apps/web > @sentry/nextjs > @rollup/plugin-commonjs > rollup` | No — build-time devDep |
| MODERATE | `esbuild@0.21.5` | Dev server CORS bypass — any site can query dev server (GHSA-67mh-4wv8-2f99) | `apps/api > vitest > vite > esbuild` (13 paths) | No — dev/test tooling only |
| MODERATE | `vite@5.4.21` | Path Traversal in Optimized Deps `.map` Handling (GHSA-4w7w-66w2-5vf9) | `apps/api > vitest > vite` (12 paths) | No — dev/test tooling only |
| MODERATE | *(third moderate included in `pnpm audit` count)* | — | — | — |

**Remediation path:**
- `rollup`: `@sentry/nextjs` must ship an updated peer dep; no direct fix available yet.
- `esbuild`/`vite`: Upgrade vitest and vite to ≥0.25.0 / ≥6.4.2 — blocked on vitest v3 compatibility.
- These are acceptable for a development phase; must be resolved before production deploy.

### 6.2 Static code checks

| Check | Result |
|---|---|
| `console.log` in production source paths | PASS — none found |
| `.env` file committed to git | PASS — `.env` is gitignored and NOT tracked (confirmed via `git ls-files`) |
| `.env` exists locally | NOTE — contains `ANTHROPIC_API_KEY`. Comment in file says "rotate after use — this was shared in chat". **Key should be rotated immediately.** |
| `TODO` without task ID | PASS — none found |
| `: any` types in production source | PASS — none found |
| Secrets in CI workflow file | PASS — no plaintext secrets (verified by `fnd-07` test suite) |

---

## 7. Build Artifacts

**Command:** `pnpm -w run build` (Turborepo — 4 packages: db, contracts, api, web)  
**Duration:** 2m 14.7s (cold, no cache)  
**Result:** PASS — 4/4 tasks successful

**Next.js bundle (apps/web):**
| Route | Size | First Load JS |
|---|---|---|
| `/` (dynamic) | 123 B | 102 kB |
| `/_not-found` (static) | 994 B | 103 kB |
| Shared chunks | — | 102 kB |

Build baseline established: **2m 15s cold build, 102 kB First Load JS**.

---

## 8. Issues Requiring Correction

### BLOCKER-1 — TypeScript typecheck failure in contracts test

**File:** `packages/contracts/src/__tests__/echo.test.ts:161`  
**Error:** `TS2345: Argument of type 'number' is not assignable to parameter of type 'string | (string | number)[]'`  
**Fix:** Change `echoContract.echo.responses[200]` to `echoContract.echo.responses[200 as unknown as string]` or type the responses accessor as `Record<number, z.ZodTypeAny>`. Alternatively, declare the variable with `as z.ZodTypeAny` directly.

### BLOCKER-2 — ai/auth/ui packages have broken test scripts

**Packages:** `@service-ai/ai`, `@service-ai/auth`, `@service-ai/ui`  
**Issue:** `package.json` declares `"test": "vitest run"` but vitest is not in devDependencies and no test files exist.  
**Fix:** Either (a) add `vitest` to devDependencies and add stub `__tests__/index.test.ts` with a placeholder test, or (b) change the test script to `echo 'no tests yet' && exit 0` until tests are written. Option (a) is preferred to keep Turborepo's test task non-failing.

### WARNING-1 — Anthropic API key in .env may need rotation

The `.env` file at workspace root contains an `ANTHROPIC_API_KEY`. The file comment acknowledges it was shared in chat. The key is NOT committed to git (properly gitignored). Rotate the key at earliest convenience.

### WARNING-2 — Audit findings in devDependencies

4 pnpm audit findings (1 high, 3 moderate) in the vitest/vite/sentry toolchain. No production risk now, but must be resolved before any production-facing deployment.

### INFO — E2E / perf / SAST not yet wired

Playwright, k6, and Semgrep are in the tech stack but not yet configured. No blocking impact for phase_foundation; wiring is expected in later phases.

---

## 9. Metrics Baselines Established

| Metric | Value |
|---|---|
| Cold build time | 2m 15s |
| Next.js First Load JS | 102 kB |
| Vitest run duration (all packages combined) | ~47s |
| pnpm audit findings (devDep only) | 4 (1 high, 3 moderate) |
| console.log in prod paths | 0 |
| any types in prod paths | 0 |
| Committed secrets | 0 |

---

*End of test results — phase_foundation — Run 1*
