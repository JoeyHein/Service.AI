# Phase Gate: phase_tenancy_franchise

**Written before build begins. Criteria here cannot be loosened mid-phase.**

This is phase 2 of 13. Inherits foundation baselines. Multi-tenancy is load-bearing: every subsequent phase builds on the `RequestScope` contract and RLS policies established here.

**Scope decision (Joey, 2026-04-22):** strict RLS everywhere (defense in depth), email stubbed in dev (console.log the magic link / invite link; Resend provider swappable later when white-label tenant email strategy is known).

---

## Must Pass (BLOCKERS — any failure rejects the gate)

### Auth (Better Auth)

- [ ] `packages/auth` exports a configured Better Auth instance, session middleware, and `getSession(request)` helper
  - **Verification:** `grep -E "export (const|function) " packages/auth/src/index.ts` shows `auth`, `withAuth` (or equivalent middleware), `getSession`
- [ ] Better Auth schema tables (`users`, `sessions`, `accounts`, `verifications`) exist in `packages/db/src/schema.ts` and in the migration set
  - **Verification:** `grep -l "pgTable('users'" packages/db/src/schema*.ts` returns a match; migration file for auth tables exists with both `.sql` and `.down.sql`
- [ ] Sign up → sign in → sign out works end-to-end via HTTP
  - **Verification:** Integration test in `apps/api/src/__tests__/auth.test.ts` covers the three-call sequence against an in-memory or mocked adapter
- [ ] Session cookie is httpOnly, sameSite=lax, secure=true when `NODE_ENV=production`
  - **Verification:** Test asserts Set-Cookie attributes on a successful sign-in response
- [ ] `GET /api/v1/me` returns `{ ok: true, data: { user, scopes } }` when authenticated, `{ ok: false, error: { code: 'UNAUTHENTICATED' } }` with 401 otherwise
  - **Verification:** Integration tests cover both cases
- [ ] Magic link email in dev mode logs the accept URL to stdout (not a no-op); provider interface is swappable
  - **Verification:** `grep -E "sendMagicLink|logMagicLink" packages/auth/src/*.ts` shows the stub implementation; test verifies the log line on a magic-link sign-in request

### Schema & Migrations

- [ ] Tables present in Drizzle schema: `franchisors`, `franchisees`, `locations`, `memberships`, `audit_log`
  - **Verification:** `grep -E "pgTable\('(franchisors|franchisees|locations|memberships|audit_log)'" packages/db/src/schema*.ts` returns all 5
- [ ] Enums defined in schema: `scope_type` (values include `platform`, `franchisor`, `franchisee`, `location`), `role` (values include `platform_admin`, `franchisor_admin`, `franchisee_owner`, `location_manager`, `dispatcher`, `tech`, `csr`)
  - **Verification:** `grep -E "pgEnum\('(scope_type|role)'" packages/db/src/schema*.ts` shows both enums with the listed values
- [ ] Every tenant-scoped table carries `franchisee_id` (and `location_id` where applicable), `created_at`, `updated_at`
  - **Verification:** Schema inspection — columns present on `memberships`, `audit_log`, and every future tenant table
- [ ] `pnpm db:migrate` applies cleanly on a fresh Postgres 16 instance; `pnpm db:migrate:down` reverts cleanly
  - **Verification:** Migration runner exits 0 up and down; `\d franchisors` works after up, fails after down
- [ ] Every foreign key has an index
  - **Verification:** `grep -E "\.references\(" packages/db/src/schema*.ts` — for each match there is a corresponding index definition
- [ ] Unique constraint: one active membership per `(user_id, scope_type, scope_id)`
  - **Verification:** Migration creates a partial unique index where `deleted_at IS NULL`; test attempts duplicate insert and expects 23505
- [ ] Partial unique index on `users.phone` where `phone IS NOT NULL`
  - **Verification:** Migration has `CREATE UNIQUE INDEX ... WHERE phone IS NOT NULL`; test inserts two users with null phone (allowed) and two with same non-null phone (rejected)

### Row-Level Security (defense in depth)

- [ ] ROW LEVEL SECURITY is ENABLED on every tenant-scoped table
  - **Verification:** Migration issues `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY` for every tenant-scoped table; `pg_class.relrowsecurity` is true for each
- [ ] A session-GUC-based policy exists on every tenant-scoped table that refuses rows outside `current_setting('app.franchisee_id', true)` unless the caller is platform admin (`current_setting('app.role', true) = 'platform_admin'`)
  - **Verification:** Migration defines `CREATE POLICY ... FOR ALL USING (...)` for each table; integration test with GUC unset shows zero rows; with correct GUC shows scoped rows
- [ ] `packages/db` exposes a `withScope(scope, fn)` helper that sets the GUCs inside a transaction and unsets them on exit
  - **Verification:** Helper implementation + test: two concurrent requests with different scopes see different row sets

### API Scoping Middleware

- [ ] Fastify plugin `requestScope` runs on every authenticated route and attaches a strongly-typed `request.scope` discriminated union
  - **Verification:** `grep -E "request.scope" apps/api/src` shows usage; type-level test in `apps/api/src/__tests__/scope.test.ts` that references `request.scope` compiles
- [ ] Unauthenticated access to a scoped route returns 401 (no session), not 500
  - **Verification:** Integration test hits a scoped route without cookie, expects 401 + `{ok:false, error:{code:'UNAUTHENTICATED'}}`
- [ ] IDOR test: a franchisee-scoped user's request for a record belonging to another franchisee returns 403 or 404, never the row
  - **Verification:** ≥20 IDOR test cases across representative scoped endpoints, all pass

### Impersonation & Audit

- [ ] `X-Impersonate-Franchisee` header is honored only for `franchisor_admin` members of the target franchisee's parent franchisor
  - **Verification:** Test matrix — franchisor_admin of parent A impersonating franchisee in A (allowed), franchisor_admin of A impersonating franchisee in B (403), non-admin roles setting the header (403)
- [ ] Every impersonated read/write creates an `audit_log` row with `actor_user_id`, `target_franchisee_id`, `action`, `scope_type`, `metadata`, `created_at`
  - **Verification:** Test performs impersonated write, asserts `audit_log` row shape and content

### Invitation Flow

- [ ] Invite token is 32 random bytes, single-use, expires in 72h
  - **Verification:** `grep -E "randomBytes\(32\)|72 \* 60 \* 60" apps/api/src` shows both; test confirms reuse returns 410 (`INVITE_USED`) and post-72h returns 410 (`INVITE_EXPIRED`)
- [ ] Role validation: an inviter can only invite roles allowed by their own scope (e.g., location_manager cannot invite franchisor_admin)
  - **Verification:** Test matrix covers all invalid pairs; each returns 403
- [ ] Redemption either signs in an existing user or routes to sign-up with the email prefilled
  - **Verification:** Integration test covers both branches
- [ ] Revoking a pending invite is idempotent (second call returns 200 with `alreadyRevoked: true`)
  - **Verification:** Test performs two consecutive revokes

### Seed

- [ ] `pnpm seed` is idempotent and creates: 1 platform admin (`joey@opendc.ca`), Elevated Doors franchisor, 2 franchisees (Denver, Austin), each with 1 location, 1 owner, 1 manager, 1 dispatcher, 2 techs, 1 CSR
  - **Verification:** Run `pnpm seed` twice — second run exits 0, no duplicate-key errors; `SELECT count(*) FROM users` returns the same number both times
- [ ] Seeded users can sign in with a documented password (dev only — `changeme123` or equivalent, clearly marked)
  - **Verification:** README.md seed section documents the password; integration test signs in as one seeded user

### Security Test Suite

- [ ] ≥40 tests in a dedicated security test file cover: anonymous access, wrong-tenant access, privilege escalation via role tampering, impersonation misuse, invite token reuse/expiry, session hijacking prevention
  - **Verification:** `pnpm --filter @service-ai/api test --reporter=verbose 2>&1 | grep -c "security"` returns ≥40; file exists at `apps/api/src/__tests__/security.test.ts`
- [ ] Coverage on `packages/auth` ≥ 90%
  - **Verification:** `pnpm --filter @service-ai/auth coverage` exits 0 with line/branch ≥ 90%

### Unit + Integration Test Suite

- [ ] `pnpm turbo test --force` exits 0 across every workspace project (no Turbo cache replay)
  - **Verification:** Exit code 0; output shows `Cached: 0 cached, N total`
- [ ] No tests skipped except with a one-line comment explaining why (infrastructure-dependent only)
  - **Verification:** `grep -rn "\.skip(" apps packages` — every match is adjacent to a comment

---

## Must Improve Over Previous Phase

- [ ] No regression in `phase_foundation` tests (`pnpm -r test` still exits 0)
- [ ] `pnpm -r build` wall time stays ≤ 150% of foundation baseline
- [ ] No new `pnpm audit --audit-level=high` findings

---

## Security Baseline (inherited + tightened)

- [ ] No secrets in code; `.env` remains gitignored
- [ ] Every scoped endpoint has 401 + 403 tests
- [ ] No SQL string concatenation introduced (Drizzle query builder or parameterized only)
  - **Verification:** `grep -rE "raw\(|execute\(\`" packages apps` — every match has an `-- safe:` comment justifying it
- [ ] Session cookies are rotated on privilege changes (role assignment, impersonation toggle)

---

## Documentation

- [ ] `docs/ARCHITECTURE.md` gains a "Tenancy Model" section: franchisor → franchisee → location → user hierarchy with a Mermaid diagram
- [ ] `docs/api/tenancy.md` documents every new endpoint (request/response shapes, auth requirements)
- [ ] `CLAUDE.md` Required Patterns section references the `RequestScope` middleware and `withScope` helper as the canonical tenancy entry points

---

## Gate Decision

_(Filled in by reviewer after all BLOCKER criteria are verified)_

**Verdict:** _(pending)_
