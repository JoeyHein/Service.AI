# Phase Gate: <PHASE_NAME>

**Written before build begins. Criteria here cannot be loosened mid-phase.**

## Must Pass (BLOCKERS — any failure rejects the gate)

- [ ] <specific checkable criterion>
  - **Verification:** <exact command to run or file to inspect>
- [ ] Unit test coverage ≥ 80% on this phase's code
  - **Verification:** `npm run coverage -- --phase=<phase>` shows ≥80%
- [ ] All E2E tests in `tests/e2e/<phase>/**/*.spec.ts` pass
  - **Verification:** `npm run test:e2e -- --phase=<phase>` exits 0
- [ ] Zero BLOCKER findings in final audit
  - **Verification:** Latest `phases/<phase>_AUDIT_*.md` shows 0 BLOCKERS
- [ ] No N+1 queries introduced on phase endpoints
  - **Verification:** Query log under load test shows query count scales linearly

## Must Improve Over Previous Phase

- [ ] No regression in prior phase test suites
  - **Verification:** `npm test` across all prior phases exits 0
- [ ] Build time does not grow >20% over previous phase
  - **Verification:** CI timing comparison
- [ ] Bundle size growth <15%
  - **Verification:** `npm run analyze` output comparison

## Security Baseline

- [ ] No new `npm audit` high/critical vulnerabilities
- [ ] All new endpoints enforce tenant isolation (IDOR test passes)
- [ ] All new endpoints validate and sanitize input
- [ ] No secrets in code (git-secrets scan passes)

## Documentation

- [ ] Public API endpoints documented in `docs/api/<phase>.md`
- [ ] Any new data model changes reflected in `docs/ARCHITECTURE.md`
- [ ] Any new patterns or conventions added to `CLAUDE.md`

## Gate Decision

<filled in by reviewer>
APPROVED | REJECTED
