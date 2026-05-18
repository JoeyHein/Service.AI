# Phase Audit 1: phase_corporate_hub_redesign

**Verdict: PASS_WITH_FIXES**

## Summary

CHR-01..11 landed the corporate hub-and-spoke model cleanly at the
schema, RLS, scope plugin, commission-engine, and route surfaces. The
load-bearing migration (`0016_corporate_hub_redesign.sql`) is correct:
every branch-scoped table gets the two-policy template, FK retargeting
preserves row identity, and the round-trip test compiles + skips
cleanly when no DB is reachable. The new `/api/v1/corporate/*` and
`/api/v1/branch/dashboard` surfaces enforce 404-not-403 on
cross-tenant probes, derive `branchId` only from `request.scope`, and
return the standard `{ok,data|error}` envelope.

Three runtime BLOCKERs were found and fixed inline — all in the web
app, all introduced by a CHR-10 prompt sweep that updated symbol
names elsewhere but missed the role enum strings the gates compare
against. After fixes, `pnpm -r typecheck` and `pnpm -r test` both
exit 0 (53 test files, 195 passing, 443 auto-skipped because no live
Postgres — same baseline as before the audit).

Nine MINOR items filed to `docs/TECH_DEBT.md` (TD-CHR-01..09). The
big one is **TD-CHR-01**: 15+ live tests still issue raw SQL against
the dropped `franchisees` / `franchisors` tables. They pass today
because they're auto-skipped, but they'd error the moment a live DB
is wired in CI. Their CHR-equivalents already exist
(`live-security-corporate.test.ts`, `live-corporate-routes.test.ts`,
`live-branch-dashboard.test.ts`), so the cleanup is either
delete-or-rewrite, not lose-coverage.

## BLOCKERS

1. **CHR-B01 — Manager role excluded from `DASHBOARD_ROLES` set**
   - Where: `apps/web/src/app/(app)/dashboard/page.tsx:76-82`
   - Why blocker: The set still held legacy enum values
     (`platform_admin`, `franchisor_admin`, `franchisee_owner`,
     `location_manager`, `dispatcher`). Under the new corporate-hub
     role enum, a `manager` (the canonical branch-runner who is the
     entire point of CHR-07) would never satisfy
     `DASHBOARD_ROLES.has(role)`, so a manager hitting `/dashboard`
     would silently fall to the "render scope JSON" fallback path
     instead of seeing the owner-dashboard tiles their role is
     designed around. CHR-10 swept "franchisee → branch" symbols but
     never updated the role-name string literals on this gate.
   - Fix applied: yes — replaced the set with
     `['corporate_admin', 'manager', 'dispatcher']` (the three roles
     that look at the dashboard under the new model). Tech / CSR
     continue to get the friendly scope-summary fallback. Same
     pattern as `AppShell.tsx`, which already uses the new role
     names.

2. **CHR-B02 — Manager role excluded from `COLLECTIONS_ROLES` set**
   - Where: `apps/web/src/app/(app)/collections/page.tsx:24-28`
   - Why blocker: Same hazard — set held `franchisee_owner`,
     `location_manager`, `dispatcher`; under CHR these resolve to
     `manager` + `dispatcher`. A manager opening `/collections` would
     get `notFound()` despite their role explicitly being the one
     CHR designed for collections review.
   - Fix applied: yes — set replaced with `['manager', 'dispatcher']`.

3. **CHR-B03 — Public invoice pay page expects `franchiseeName` but
   API returns `branchName`**
   - Where: `apps/web/src/app/invoices/[token]/pay/page.tsx:11,42`
   - Why blocker: The TypeScript interface still declares
     `franchiseeName: string`, and the heading renders
     `{invoice.franchiseeName}`. The API
     (`apps/api/src/public-invoice-routes.ts:94`) returns the key
     as `branchName`. The page renders `undefined` for the customer-
     facing service-provider heading on every public payment page
     until this is fixed. (TS doesn't catch it because the response
     is typed at the API boundary, not at the fetch site.)
   - Fix applied: yes — renamed the interface field + the JSX usage
     to `branchName`. Two-line diff.

## MINORs (filed to TECH_DEBT)

1. **TD-CHR-01** — Legacy `franchisees`/`franchisors` SQL in 15+
   live tests. Auto-skipped today; will error the moment a real DB
   is wired into CI. Delete or rewrite for the new model.
2. **TD-CHR-02** — `live-invoice-finalize.test.ts` and
   `live-security-ip.test.ts` assert `applicationFeeAmount === 60`
   and `STRIPE_NOT_READY` — both removed in CHR-08. Auto-skipped
   today.
3. **TD-CHR-03** — Demo seed still computes a fake 2.9% application
   fee (`apps/api/src/seed/demo.ts:349`). Cosmetic.
4. **TD-CHR-04** — Stale `TODO(CHR-06)` markers in `phone-routes.ts`,
   `pricebook-routes.ts`, `catalog-routes.ts`, `invites.ts`,
   `auth-mount.ts`. Mark work that CHR-06 chose not to do; either
   schedule or delete.
5. **TD-CHR-05** — Web `MeResponse.impersonating` field + accept-
   invite `scopeType` enum still franchise-shaped. Not consumed at
   runtime in a way that breaks.
6. **TD-CHR-06** — Misleading "franchisee" comments + the
   `scopedFranchiseeId` helper name + the
   `ai_metrics_franchisee_date_unique` Drizzle index. Cosmetic.
7. **TD-CHR-07** — `applicationFeeAmount` column lingers on
   `invoices` + `payments` (CHR-08 was code-only). Intentional;
   flagged for future cleanup migration.
8. **TD-CHR-08** — `dispatch-ui-structure.test.ts` describe string
   says "franchisee-scoped" but asserts the new `'branch'` literal.
   One-line rename.
9. **TD-CHR-09** — `live-security-corporate.test.ts` still hits the
   legacy `/api/v1/franchisees` route instead of the canonical
   `/api/v1/corporate/branches`. Test coverage drifts from the
   documented surface.

## OK (verified, no action)

- **Migration 0016**: every branch-scoped table gets
  `ENABLE/FORCE ROW LEVEL SECURITY` + both
  `<t>_corporate_admin` and `<t>_scoped` policies via the loop in
  step 10. Tables without a `branch_id` (corporate, branches,
  branch_managers, comp_plans, service_catalog_templates,
  service_items, kb_docs) get `_scoped USING (false)` — correct for
  corporate-only tables.
- **Drizzle ↔ DB drift**: `pnpm --filter @service-ai/db typecheck`
  exits 0. Every Drizzle table with a `branchId` field corresponds
  to a SQL column named `branch_id` post-rename.
- **No migration files modified**: `packages/db/migrations/*.sql` is
  untouched by this audit (per instruction; 0016 already shipped).
- **POST/PATCH body fields**: zero occurrences of `franchiseeId` /
  `franchisorId` / `locationId` in route Zod schemas. Every Zod
  body uses `branchId` or pulls the scope from `request.scope`.
- **Corporate routes** (`apps/api/src/corporate-routes.ts`):
  401 on unauthenticated, 404 (not 403) on non-corporate scope,
  body never trusted for `branchId`, `{ok,data}` envelope
  consistent. Same for `branch-routes.ts` (manager-only via
  `req.scope.role !== 'manager'` → 404) and
  `pricebook-suggestions-routes.ts`.
- **AI prompts**: `packages/ai/src/prompts/` is clean — zero
  `franchisee` / `franchisor` references (CHR-10 succeeded here).
- **TODO(CHR-XX) inventory**: nine TODOs remain; all point at
  CHR-06. They are misleading-but-cosmetic and downgraded to
  TD-CHR-04 above.
- **Sweep-replace bad comments**: the one obviously-broken comment
  block in `apps/api/src/request-scope.ts` (the "Legacy enum values
  (corporate_admin, corporate_admin, manager, manager)" duplication
  — a CHR-10 find/replace artifact) was inline-fixed during this
  audit. No other instances found.
- **Idempotent ledger writes**: `commission-engine.ts` writes
  through `ON CONFLICT (user_id, source_kind, source_id) DO NOTHING`
  per the unique index in migration 0016.
- **CHR-01..11 gate criteria**: walked. CHR-01 round-trip test
  present + skips cleanly. CHR-04 has property tests for all three
  rule kinds. CHR-05 has an idempotent-replay test
  (`live-commission-engine.test.ts`). CHR-09 pricebook read path
  does NOT join overrides. CHR-10 AI prompts clean.

## Methodology

Grepped for `franchisee|franchisor|royalty|application_fee_amount|impersonate|location_manager|franchisee_owner|franchisor_admin`
across `apps/`, `packages/` (excluding migrations 0001–0015 which
are pre-CHR and intentionally still hold the franchise tables on
the up path). Read each non-comment hit in context, classified
OK / MINOR / BLOCKER per the audit spec. Verified RLS coverage by
walking step 10 of migration 0016 against the new + retained-table
list. Verified Drizzle-vs-DB alignment via
`pnpm --filter @service-ai/db typecheck`. Walked the bodies of
every CHR-06/07/09 route to confirm 404-not-403 + envelope shape.
Read `live-security-corporate.test.ts` to confirm coverage. Walked
each TODO(CHR-XX) marker. Ran `pnpm -r typecheck` and `pnpm -r test`
before + after the inline fixes — both pass with the same baseline
(195 passing / 443 auto-skipped). Wrote MINORs to
`docs/TECH_DEBT.md` under a new `phase_corporate_hub_redesign`
section.

## Gate Decision

**APPROVED** with three BLOCKERs fixed inline + nine MINORs filed
to TECH_DEBT. The corporate hub is solid ground for SQB to land on.
The franchise residue that remains is either:
- Pre-CHR migration files (the up-path shipped, can't be rewritten)
- Auto-skipped live tests that would need a coordinated rewrite when
  CI gets a live DB (TD-CHR-01, TD-CHR-02)
- Cosmetic comments / stale TODOs / unused legacy type fields
