# Correction: phase_foundation — Cycle 3

**Date:** 2026-04-22
**Corrector:** Autonomous Corrector
**Audit addressed:** phases/phase_foundation_AUDIT_3.md
**Prior corrections:** phases/phase_foundation_CORRECTION_2.md (Cycle 2), phases/phase_foundation_CORRECTION_1.md (Cycle 1)

---

## Summary

Both AUDIT_3 blockers (B1 and B2) were resolved in the committed history prior to this cycle (commit `05729076`). This correction cycle:

1. Confirmed the B1 fix (rollup CVE `pnpm.overrides`) is already present and `pnpm audit --audit-level=high` exits 0.
2. Confirmed the B2 fix (`apiClient.echo()` is actually called and `result.body.data.echo` is accessed in `page.tsx`) is already present and TypeScript enforces the contract shape.
3. **Fixed a test regression introduced by the B2 fix**: `apps/web/src/__tests__/structure.test.ts` contained a test asserting that `page.tsx` references `/api/v1/health`, which was correct before the B2 fix but was invalidated when the page was rewritten to use the ts-rest echo client. That stale test was updated to match the actual implementation.
4. **Added AUDIT-3 regression tests** (B1 and B2 suites) so that future regressions on these exact issues surface immediately in `pnpm -r test`.

After this cycle: `pnpm -r test` exits 0 (129 tests: 49 API, 29 web, 21 contracts, 19 DB, 11 voice). `pnpm -r typecheck` exits 0 across all 8 packages. `pnpm audit --audit-level=high` exits 0.

---

## B1 — CONFIRMED FIXED: `pnpm audit --audit-level=high` exits 1 (rollup HIGH CVE)

**Audit finding:** `rollup@3.29.5` (transitive via `@sentry/nextjs → rollup@3.29.5`) carries GHSA-mw96-cpmx-2vgc (Arbitrary file write via path traversal, HIGH severity). The root `package.json` had no `pnpm.overrides` section. `pnpm audit --audit-level=high` exited 1.

**Root cause:** Without a `pnpm.overrides` pinning rollup to a patched version, pnpm resolves `@rollup/plugin-commonjs`'s `rollup` peer to the vulnerable `3.29.5` range.

**Fix (commit `05729076`, prior cycle):** Added to root `package.json`:
```json
"pnpm": {
  "overrides": {
    "rollup": ">=3.30.0"
  }
}
```

**Verification:** `pnpm audit --audit-level=high` → exits 0. 3 moderate vulnerabilities remain (not in scope for this gate); 0 high or critical.

**Regression tests added (this cycle):** `apps/web/src/__tests__/structure.test.ts` — `AUDIT-3 / B1 regression / rollup CVE pnpm override` suite (2 tests):
- `root package.json has a pnpm.overrides section` — guards against the override block being accidentally removed or restructured.
- `pnpm.overrides pins rollup to >=3.30.0 to fix GHSA-mw96-cpmx-2vgc` — asserts the rollup specifier satisfies the `>=3.30.0` constraint; will fail if someone downgrades or removes the pin.

**Files changed (this cycle):** `apps/web/src/__tests__/structure.test.ts`

---

## B2 — CONFIRMED FIXED: ts-rest client declared but never called (tautological type check)

**Audit finding:** `apps/web/src/app/page.tsx` initialised `apiClient = initClient(echoContract, ...)` but the only use was:
```ts
void (apiClient satisfies typeof apiClient);
```
This is a tautology — `satisfies typeof apiClient` always holds. The client was never invoked; no response type was ever accessed; TypeScript never checked the response shape against the contract. Mutating `EchoResponseSchema` caused zero compile errors.

**Root cause:** The corrector for AUDIT_2/B3 wired the `initClient` call but stopped short of an actual call site. Without a call that consumes the return type, the TypeScript compiler has nothing to check against the contract schema.

**Fix (commit `05729076`, prior cycle):** Rewrote `apps/web/src/app/page.tsx` to add a `getEchoStatus()` async function that:
1. Calls `apiClient.echo({ body: { message: 'ping' } })`.
2. Checks `result.status === 200` (discriminated-union narrowing).
3. Returns `result.body.data.echo` — a typed access path that would produce a compile error if `EchoResponseSchema` renames or removes the `echo` field.

The function is called from the `Home` server component, so the entire call chain is present and type-checked at every compilation.

**Empirical verification:** Changing `EchoResponseSchema` to `z.object({ ok: z.literal(true), data: z.object({ echo: z.string(), renamed: z.string() }) })` and removing the `echo` property causes `pnpm --filter @service-ai/web typecheck` to exit non-zero with:
```
Property 'echo' does not exist on type '{ renamed: string }'
```
at `apps/web/src/app/page.tsx:37`.

**Test regression fixed (this cycle):** Prior to this correction, `apps/web/src/__tests__/structure.test.ts` contained:
```ts
it('references the GET /api/v1/health endpoint (fetch or constant)', () => {
  expect(content.includes('/api/v1/health')).toBe(true);
});
```
This test was correct when `page.tsx` used a plain `fetch('/api/v1/health')` call (pre-B2 fix). After the B2 fix rewrote the page to call the echo endpoint via `apiClient.echo()`, this test started failing silently in the unstaged working tree. It was updated to:
```ts
it('calls the ts-rest echo client or references the /api/v1/echo endpoint', () => {
  const referencesEchoCall = content.includes('apiClient.echo') || content.includes('/api/v1/echo');
  expect(referencesEchoCall).toBe(true);
});
```

**Regression tests added (this cycle):** `apps/web/src/__tests__/structure.test.ts` — `AUDIT-3 / B2 regression / ts-rest client invoked with typed response` suite (3 tests):
- `page.tsx calls apiClient.echo()` — verifies an actual call site exists (not just an `initClient` declaration), so TypeScript is forced to check the request shape.
- `page.tsx accesses result.body.data.echo` — verifies the exact property path that would fail to compile if the contract renames or removes the `echo` field.
- `page.tsx checks result.status === 200 before accessing typed body` — verifies the discriminated-union status guard is present; without it, `body.data` access would be on the unnarrowed union type and might not enforce the correct branch.

**Files changed (this cycle):** `apps/web/src/__tests__/structure.test.ts`

---

## Test counts after this cycle

| Suite | Before this cycle | After this cycle | Delta |
|---|---|---|---|
| `apps/api` | 49 | 49 | — |
| `apps/web` | 24 | **29** | +5 (B1 suite ×2, B2 suite ×3, health-check test updated ×1 net) |
| `packages/contracts` | 21 | 21 | — |
| `apps/voice` | 11 | 11 | — |
| `packages/db` | 19 | 19 | — |
| **Total** | **124** | **129** | **+5** |

---

## Verification commands

```bash
# All tests pass
pnpm -r test                    # exits 0, 129 tests

# Typecheck clean across all 8 packages
pnpm -r typecheck               # exits 0

# Lint clean
pnpm -r lint                    # exits 0

# Build artifacts produced
pnpm -r build                   # exits 0; apps/web/.next, apps/api/dist, apps/voice/dist

# Zero high/critical CVEs
pnpm audit --audit-level=high   # exits 0 (3 moderate, 0 high)
```

---

## Open items (not AUDIT_3 scope, carried forward from prior audits)

| ID | Issue |
|----|-------|
| AUDIT3-W1 | `tests/foundation/` not in pnpm workspace — 132 foundation tests invisible to `pnpm -r test` |
| AUDIT3-W2 | Docker Compose app services lack `healthcheck:` stanzas |
| AUDIT3-W3 | `Sentry.setupFastifyErrorHandler(app)` not called — request context missing from Sentry events |
| AUDIT3-W4 | No SIGTERM in-flight integration test |
| AUDIT3-W5 | API echo route uses raw Fastify, not `@ts-rest/fastify` server handler |
| AUDIT3-W6 | `.do/app.yaml` references placeholder GitHub repo `your-org/service-ai` |
| AUDIT3-W7 | `time pnpm -r build` wall-time baseline not recorded in phase artifacts |
