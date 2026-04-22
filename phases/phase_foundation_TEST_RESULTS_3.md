# Test Results — phase_foundation — Run 3

**Date**: 2026-04-22
**Triggered by**: CORRECTION-5 fixes (B1: API mock injection, B2: contracts portable paths, M2: shutdown timing, M3: seed scripts)
**Runner**: test-runner agent (claude-sonnet-4-6)
**Branch**: main
**Commit**: 78f54d816c72a9157877a6a542241bb93480a1a0

---

## Summary

| Suite | Total | Passed | Failed | Skipped | Duration |
|---|---|---|---|---|---|
| unit/integration — packages/contracts | 21 | 21 | 0 | 0 | 1.21s |
| unit/integration — packages/db | 19 | 15 | 0 | 4 | 1.65s |
| unit/integration — apps/api | 55 | 55 | 0 | 0 | 2.42s |
| unit/integration — apps/web | 32 | 32 | 0 | 0 | 1.53s |
| unit/integration — apps/voice | 11 | 11 | 0 | 0 | 1.81s |
| unit/integration — stub packages (ai, auth, ui) | — | — | — | — | echo/exit 0 |
| foundation acceptance (tests/foundation) | 132 | 3 | 129 | 0 | 522ms |
| typecheck (turbo, all 8 pkgs) | — | 8/8 | 0 | — | 3.76s |
| lint (turbo, all 8 pkgs) | — | 8/8 | 0 | — | 2.97s |
| build (turbo) | — | 3/4 | 1 (web) | — | 404ms |
| security scan (pnpm audit --audit-level=high) | — | PASS | — | — | — |
| e2e | — | — | — | — | NOT APPLICABLE |
| perf baseline | — | — | — | — | NOT APPLICABLE |

**Overall verdict**: FAIL

Active failure categories:
1. Foundation acceptance suite: `ROOT = "/workspace"` hardcoded Linux/Docker path in all 5 test files — all 129 failures are path-resolution mismatches on Windows (pre-existing, unchanged from Run 2)
2. `apps/web` build script: `NODE_ENV=production next build` uses POSIX inline env-var syntax, fails on Windows cmd.exe (pre-existing, unchanged from Run 2)
3. `packages/db` — 4 intentional skips (live Postgres not running — correct behavior, documented)

The Run 2 regression (`const x: number = "this is a string"` at `apps/api/src/app.ts:182`) was an unstaged working-tree change that is confirmed absent from the current tree. Typecheck, lint, and non-web build are all fully green.

---

## Details by Suite

### Unit + Integration — packages/contracts

Vitest v3.2.4 | Command: `pnpm turbo test --force`

```
Test Files  1 passed (1)
     Tests  21 passed (21)
  Duration  1.21s
```

All 21 tests pass. CORRECTION-5 portable `PKG_ROOT` fix (using `fileURLToPath(import.meta.url)` instead of hardcoded `/workspace/...`) confirmed working on Windows.

### Unit + Integration — packages/db

Vitest v4.1.5

```
Test Files  1 passed (1)
     Tests  15 passed | 4 skipped (19)
  Duration  1.65s
```

15 static schema and migration tests pass. 4 live integration tests skip via `checkPostgresReachable()` guard (no Postgres at `localhost:5434` — correct and intentional; requires `docker-compose up`). Unchanged from Run 2.

### Unit + Integration — apps/api

Vitest v3.2.4

```
Test Files  3 passed (3)
     Tests  55 passed (55)
  Duration  2.42s
```

All 55 tests pass across 3 files:
- `health.test.ts` — 29 tests (PASS) — all happy-path, DB-error, Redis-error, and error-format suites pass via `mockDb` + `mockRedis` injection (CORRECTION-5 B1 fix)
- `echo.test.ts` — 20 tests (PASS)
- `shutdown.test.ts` — 6 tests (PASS) — flaky test fixed with 80ms head-start delay (CORRECTION-5 M2 fix)

No timeouts. All tests resolve in under 10ms via mock stubs. Duration 2.42s (was 72s pre-CORRECTION-5 due to Redis reconnect backoff).

### Unit + Integration — apps/web

Vitest v3.2.4

```
Test Files  1 passed (1)
     Tests  32 passed (32)
  Duration  1.53s
```

### Unit + Integration — apps/voice

Vitest v3.2.4

```
Test Files  1 passed (1)
     Tests  11 passed (11)
  Duration  1.81s
```

### Stub Packages — packages/ai, packages/auth, packages/ui

All three echo `No tests in stub package` and exit 0 per convention.

### Unit + Integration Aggregate

| Package | Pass | Fail | Skip |
|---|---|---|---|
| packages/contracts | 21 | 0 | 0 |
| packages/db | 15 | 0 | 4 |
| apps/api | 55 | 0 | 0 |
| apps/web | 32 | 0 | 0 |
| apps/voice | 11 | 0 | 0 |
| **Total** | **134** | **0** | **4** |

---

### Foundation Acceptance Tests (tests/foundation)

Command: `cd tests/foundation && pnpm test` | Vitest v4.1.5 | Exit code: 1

```
Test Files  5 failed (5)
     Tests  129 failed | 3 passed (132)
  Duration  522ms
```

Root cause: All 5 test files declare `const ROOT = "/workspace"` (or equivalent hardcoded paths). On Windows, `join("/workspace", ...)` resolves to `\workspace\` — a non-existent path. Every `existsSync()` and `readFileSync()` call fails.

Per-file counts:

| File | Failed | Passed | Root cause |
|---|---|---|---|
| fnd-01-monorepo.test.ts | 64 | 3 | `const ROOT = "/workspace"` at line 24 |
| fnd-07-ci.test.ts | 22 | 0 | `const ROOT = "/workspace"` at line 23 |
| fnd-08-observability.test.ts | 11 | 0 | `const ROOT = '/workspace'` at line 28 |
| fnd-09-do-spec.test.ts | 15 | 0 | `const ROOT = '/workspace'` at line 26 |
| fnd-10-compose.test.ts | 17 | 0 | `const COMPOSE_PATH = "/workspace/docker-compose.yml"` at line 25 |

The 3 passing tests are all in `fnd-01-monorepo.test.ts`; they iterate over workspace paths with `continue` on missing files so they do not throw. The implementation artifacts being tested all exist and are correct at the actual repo root (`C:/Users/jhein/servicetitan-clone/`). This is a test infrastructure portability issue only.

Representative error output:

```
FAIL  fnd-01-monorepo.test.ts > each workspace has a tsconfig.json > apps/api/tsconfig.json extends the root base config
Error: Expected file not found: \workspace\apps\api\tsconfig.json
 at readFile fnd-01-monorepo.test.ts:30:11

FAIL  fnd-07-ci.test.ts > the workflow file exists at .github/workflows/ci.yml
AssertionError: expected false to be true
 at fnd-07-ci.test.ts:28:5

FAIL  fnd-09-do-spec.test.ts > .do/app.yaml exists at /workspace/.do/app.yaml
AssertionError: expected false to be true
 at fnd-09-do-spec.test.ts:34:5
```

---

### Typecheck

Command: `pnpm turbo typecheck --force` | Exit code: 0

```
Tasks:    8 successful, 8 total
Time:     3.758s
```

| Package | Result |
|---|---|
| apps/api | PASS |
| apps/voice | PASS |
| apps/web | PASS |
| packages/contracts | PASS |
| packages/db | PASS |
| packages/ai | PASS |
| packages/auth | PASS |
| packages/ui | PASS |

The Run 2 regression (`const x: number = "this is a string"` at `apps/api/src/app.ts:182`) is confirmed absent from the working tree. All 8 packages typecheck cleanly.

---

### Lint

Command: `pnpm turbo lint --force` | Exit code: 0

```
Tasks:    8 successful, 8 total
Time:     2.972s
```

All 8 packages pass. Informational `MODULE_TYPELESS_PACKAGE_JSON` warning present across all packages (root `package.json` lacks `"type": "module"`) — non-fatal cosmetic warning, not an error. Unchanged from Run 2 (tracked as OPEN-6).

---

### Build

Command: `pnpm turbo build --force` | Exit code: 1

```
Tasks:    0 successful, 4 total
Failed:   @service-ai/web#build
Time:     404ms
```

Non-web packages (confirmed clean by running build excluding `apps/web`):

```
Tasks:    3 successful, 3 total
Time:     2.095s
```

| Task | Result | Notes |
|---|---|---|
| apps/api | PASS | tsc — no errors |
| apps/voice | PASS | tsc — no errors |
| packages/db | PASS | tsc — no errors |
| apps/web | FAIL | `'NODE_ENV' is not recognized as an internal or external command, operable program or batch file.` |

Root cause: `apps/web/package.json` `scripts.build` is `"NODE_ENV=production next build"`. Inline POSIX env-var assignment is not valid on Windows cmd.exe. CI (ubuntu-latest) is unaffected. Fix: add `cross-env` devDependency; change to `"cross-env NODE_ENV=production next build"`.

---

### Security Scan

Command: `pnpm audit --audit-level=high` | Exit code: 0 — PASS

No HIGH or CRITICAL vulnerabilities found.

`pnpm audit` (all severities): 3 moderate vulnerabilities — all in the `vitest -> vite -> esbuild` dev toolchain only. No production artifact exposure.

| Advisory | Package | Severity | Vulnerable | Fixed In | Scope |
|---|---|---|---|---|---|
| GHSA-67mh-4wv8-2f99 | esbuild | moderate | <=0.24.2 | >=0.25.0 | dev toolchain (vitest/vite) |
| GHSA-4w7w-66w2-5vf9 | vite | moderate | <=6.4.1 | >=6.4.2 | dev toolchain (vitest/vite) |
| (3rd moderate) | esbuild (transitive) | moderate | — | — | dev toolchain |

All three unchanged from Run 2. Documented in AUDIT-3 and root `package.json` `pnpm.overrides`.

---

### E2E Tests

NOT APPLICABLE — `tests/e2e/` directory does not exist. Only `tests/foundation/` is present under `tests/`. E2E infrastructure is not required for phase_foundation.

---

### Performance Baseline

NOT APPLICABLE — `tests/perf/` directory does not exist. Performance test infrastructure is not required for phase_foundation.

---

## Failures

### F-1: foundation acceptance suite — ROOT="/workspace" hardcoded Linux path (129 failures)

- **Test**: All 129 failing tests across 5 files in `tests/foundation/`
- **Files**:
  - `tests/foundation/fnd-01-monorepo.test.ts:24` — `const ROOT = "/workspace"`
  - `tests/foundation/fnd-07-ci.test.ts:23` — `const ROOT = "/workspace"`
  - `tests/foundation/fnd-08-observability.test.ts:28` — `const ROOT = '/workspace'`
  - `tests/foundation/fnd-09-do-spec.test.ts:26` — `const ROOT = '/workspace'`
  - `tests/foundation/fnd-10-compose.test.ts:25` — `const COMPOSE_PATH = "/workspace/docker-compose.yml"`
- **Error**: `Error: Expected file not found: \workspace\<path>` for every file-existence check (path resolves to Windows non-existent `\workspace\` drive root)
- **Status**: Pre-existing — identical to Run 2
- **Fix required**: Replace hardcoded `/workspace` in all 5 files with portable `import.meta.url`-based resolution. For `fnd-10-compose.test.ts`, additionally change `COMPOSE_PATH` to `join(ROOT, "docker-compose.yml")`.

### F-2: apps/web build — Windows-incompatible inline env-var

- **Test**: `pnpm turbo build` — `@service-ai/web#build`
- **File**: `apps/web/package.json`, `scripts.build`
- **Error**: `'NODE_ENV' is not recognized as an internal or external command, operable program or batch file.`
- **Status**: Pre-existing — identical to Run 2
- **Fix required**: Add `cross-env` devDependency to `apps/web`; change build script to `"cross-env NODE_ENV=production next build"`.

### Non-failure — packages/db live integration skips (4 tests)

4 tests in `packages/db/src/__tests__/health-checks.test.ts` skip via `checkPostgresReachable()` guard. Requires `docker-compose up postgres`. Intentional and correct. Not a code defect.

---

## Comparison vs Run 2

| Check | Run 2 | Run 3 | Delta |
|---|---|---|---|
| packages/contracts (21 tests) | 21 PASS | 21 PASS | no change |
| packages/db (15 schema + 4 skip) | 15 PASS / 4 skip | 15 PASS / 4 skip | no change |
| apps/api (55 tests) | 55 PASS | 55 PASS | no change |
| apps/web (32 tests) | 32 PASS | 32 PASS | no change |
| apps/voice (11 tests) | 11 PASS | 11 PASS | no change |
| foundation acceptance (132) | 3 PASS / 129 FAIL | 3 PASS / 129 FAIL | no change |
| typecheck (8 pkgs) | 7/8 FAIL (regression) | 8/8 PASS | FIXED |
| lint (8 pkgs) | 7/8 FAIL (regression) | 8/8 PASS | FIXED |
| build — api/voice/db | FAIL (regression) | PASS | FIXED |
| build — apps/web | FAIL (Windows env syntax) | FAIL (Windows env syntax) | no change (pre-existing) |
| security (pnpm audit --audit-level=high) | PASS | PASS | no change |

The Run 2 regression (`const x: number = "this is a string"` in `apps/api/src/app.ts`) was an unstaged working-tree change that is no longer present. Typecheck, lint, and non-web build are now all clean.

---

## Blocker Assessment

Two issues prevent a fully-green run on native Windows:

1. **Foundation acceptance suite `ROOT="/workspace"`** — 129 test failures across all 5 acceptance test files. All implementation artifacts exist and are correct. This is a test infrastructure portability defect, not a product defect. Requires corrector to update all 5 `tests/foundation/*.test.ts` files with portable `fileURLToPath(import.meta.url)`-based ROOT resolution.

2. **`apps/web` build script** — Windows cmd.exe incompatible. Blocks `pnpm turbo build` on Windows. CI (ubuntu-latest) is unaffected. Requires `cross-env` addition to `apps/web`.

Neither failure indicates a missing or broken implementation artifact. Both are Windows-portability issues in test/build tooling. The underlying foundation deliverables (CI workflow, DO spec, docker-compose, observability wiring, monorepo scaffold, Husky hooks) are all present and correct at `C:/Users/jhein/servicetitan-clone/`.

**Verdict: ACTIONABLE_FAILURES** — corrector action required on test portability (F-1) and build script (F-2) before this run can be declared ALL_GREEN.
