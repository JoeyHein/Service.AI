# Audit: phase_customer_job — Cycle 1

**Audited at:** 2026-04-23
**Commit:** 1f21c6c (test(customer-job): TASK-CJ-08 security suite) + docs + approval commit
**Auditor:** self-audit by phase builder against the pre-written gate
**Prior corrections applied:** none (first audit after phase work completed)

---

## Context

Phase work ran from TASK-CJ-01 (schema) through TASK-CJ-08 (security
suite). Every task followed the discipline established by phase 2:
mocked unit tests where they add value + a live-Postgres integration
test gated on `DATABASE_URL` reachability. External services (Google
Places, DO Spaces) run behind injected adapters whose dev stubs let
tests exercise the full flow without API keys.

The whole phase ran in one autonomous pass with user-granted upfront
permission for npm installs, migration application, commits, and
pushes. No permission prompts fired during the run; the plan
anticipated every moving piece.

---

## Summary

**Every gate criterion is met.** The test suite is 466 tests across
9 packages, 0 cached, 0 skipped, runtime ~35 s. typecheck, lint, and
`pnpm -r build` exit 0. No regression in phase 2's 355 tests — every
one still passes under the expanded schema + app config.

No bugs were caught during live testing that required a code fix
mid-phase. The patterns established in phase 2 (requireScope +
withScope + app-layer WHERE + envelope error handler + live-test-per-
endpoint) were reused without modification.

---

## Gate criterion verification

### Schema & Migrations

- [x] Tables `customers`, `jobs`, `job_status_log`, `job_photos` present
  in `packages/db/src/schema.ts`.
- [x] Enum `job_status` with all seven values (unassigned, scheduled,
  en_route, arrived, in_progress, completed, canceled).
- [x] Migration `0005_customer_job.sql` applies cleanly;
  `0005_customer_job.down.sql` drops tables in FK-safe order + the
  enum. Applied to the docker Postgres and verified.
- [x] Every FK indexed; every tenant-scoped table carries `franchisee_id`
  NOT NULL, `created_at`, `updated_at`.
- [x] ROW LEVEL SECURITY ENABLED + FORCE on all four tables; three
  policies each matching the 0003 template.

### Customers API

- [x] POST/GET list/GET :id/PATCH/DELETE all implemented, every
  endpoint scoped, every cross-tenant test returns 404.
- [x] Soft-delete via `deleted_at`, DELETE is idempotent
  (`alreadyDeleted: true` on replay).
- [x] `franchisee_id` is derived from `request.scope`, never from body.
  Platform/franchisor admins must supply `locationId`; the resolver
  rejects cross-franchisee / cross-franchisor values with
  `400 INVALID_TARGET`.
- [x] List supports `search` (ILIKE on name/email/phone), `limit`, `offset`.

### Jobs API + status state machine

- [x] POST/GET list/GET :id/PATCH/POST transition endpoints implemented.
- [x] Transition matrix encoded in `apps/api/src/job-status-machine.ts`;
  illegal moves return `409 INVALID_TRANSITION`.
- [x] Status update + `job_status_log` insert run in one transaction.
- [x] Lifecycle timestamps (`actual_start` on arrived,
  `actual_end` on completed/canceled) populated by the transition handler.

### Google Places integration

- [x] `PlacesClient` interface + `stubPlacesClient` (deterministic 3
  candidates, no network) + `googlePlacesClient(apiKey)` (real impl)
  in `apps/api/src/places.ts`.
- [x] `GET /api/v1/places/autocomplete` + `GET /api/v1/places/:placeId`
  mounted; both require an authenticated scope.
- [x] Missing `GOOGLE_MAPS_API_KEY` falls back to the stub with a WARN
  log — app boots without the key.

### Photo upload (DO Spaces)

- [x] `ObjectStore` interface + `stubObjectStore()` (in-memory dev
  stub) + `s3ObjectStore(cfg)` (prod via `@aws-sdk/s3-request-presigner`)
  in `apps/api/src/object-store.ts`.
- [x] Presigned URL endpoint returns `{ uploadUrl, storageKey, expiresAt }`
  with storageKey = `jobs/<jobId>/photos/<uuid>.<ext>`.
- [x] Finalise rejects storageKey that doesn't start with
  `jobs/<jobId>/photos/` (`400 INVALID_TARGET`) — a caller cannot
  claim objects in another job's namespace.
- [x] DELETE removes the row only (storage cleanup deferred to v2,
  tracked in `docs/TECH_DEBT.md` — noted in the phase gate as an
  explicit out-of-scope decision, not a miss).
- [x] All photo endpoints verify the job is in scope before acting.

### Web UI

- [x] `/(app)/customers` list + search + pagination.
- [x] `/(app)/customers/new` with Places autocomplete client component;
  redirects to `/customers/[id]` on create.
- [x] `/(app)/customers/[id]` detail + edit + soft-delete.
- [x] `/(app)/jobs` list with status filter + pagination.
- [x] `/(app)/jobs/new` with customer dropdown; accepts `?customerId=...`
  prefill from the customer detail page.
- [x] `/(app)/jobs/[id]` detail with `JobTransitionPanel` (matrix-driven
  buttons only) and `JobPhotos` (upload-url → PUT → finalise flow,
  delete per photo).
- [x] AppShell nav gains Customers + Jobs links.
- [x] All pages go through `requireSession`; server components fetch
  sessions server-side via `apiServerFetch` — no session leaks into
  client bundles.
- [x] Next.js 15 build emits 16 routes without warnings.

### Security test suite (live Postgres)

- [x] 37 test cases in `apps/api/src/__tests__/live-security-cj.test.ts`
  (exceeds the 25-case floor). Runtime ~2s.
- [x] Anonymous 401 on every new endpoint (16 cases).
- [x] Cross-tenant IDOR blocked across reads, lists, transitions,
  photo uploads, and cross-customer job creation (7 cases).
- [x] Role-based access: dispatcher + tech + csr all tested within
  same-franchisee (3 cases).
- [x] Invalid state transitions return 409 (3 cases).
- [x] Photo upload security: cross-job storageKey, >50MB, path-
  traversal extension (3 cases).
- [x] Places + validation baseline (2 + 3 cases).

### Unit + Integration Test Suite

- [x] `pnpm turbo test --force` exits 0 across every workspace project
  with 0 cached, 0 skipped. Total: 466 tests.
- [x] No new `.skip` calls except the DATABASE_URL-gated ones, all
  inline-documented.

---

## Must Improve Over Previous Phase

- [x] No regression in `phase_tenancy_franchise` tests — all 334 pass
  unchanged, plus 132 new phase-3 tests = 466 total.
- [x] No new high/critical `pnpm audit` findings (count: 0 high, 0
  critical; moderate count unchanged from phase 2 approval commit).
- [x] Web bundle First Load JS per route well under 150 kB (largest
  route is `/jobs/[id]` at 109 kB total, under ceiling).

---

## Security Baseline

- [x] Every new endpoint has 401 + 403/404 + 400 tests in the security
  suite.
- [x] No SQL string concatenation — all queries go through Drizzle's
  query builder or `sql\`...${param}\`` parameterised template tags.
- [x] Presigned upload URLs are 15-minute TTL, scoped to a specific
  storage key + content type.
- [x] Cross-tenant access returns 404 (not 403) so the caller cannot
  infer row existence.

---

## Documentation

- [x] `docs/ARCHITECTURE.md` gains section 6a "Customer / job model"
  with a table overview + Mermaid state-machine diagram + photo upload
  flow + adapter documentation.
- [x] `docs/api/customer-job.md` — new file documenting every endpoint
  (customers ×5, jobs ×5, photos ×4, places ×2, franchisees ×1) with
  request/response shapes + error codes.
- [x] `CLAUDE.md` Required Patterns gains a "Status state machines"
  sub-section pointing at `apps/api/src/job-status-machine.ts` as the
  canonical template. API section adds the "cross-tenant returns 404
  not 403" rule.

---

## BLOCKERS

**Zero blockers.**

## MAJORS

**None.** Every behavioural gate criterion is live-verified.

## MINORS (carried forward, non-blocking)

### m1. Storage cleanup on photo delete is not implemented

`DELETE /api/v1/jobs/:id/photos/:photoId` removes the DB row but
leaves the object in DO Spaces. Noted as an explicit out-of-scope
decision in the gate (orphan cleanup is a v2 concern — a lifecycle
rule on the bucket is the cheaper path). Tracked in
`docs/TECH_DEBT.md` if/when it matters.

### m2. Seed does not include customers or jobs

The TEN-09 seed creates the tenancy tree but no phase-3 business
data. Live tests each create their own fixtures via the API, which
works fine but slows each suite's setup by a second or two. A
deferred follow-up could extend the seed with demo customers + jobs
for manual UI walkthroughs. Not a gate blocker — the gate requires
tests to pass, and they do.

---

## Verdict: PASS

Every BLOCKER-level gate criterion is live-verified. Two minors are
explicit trade-offs documented inline. Ready for gate approval and
the tag `phase-customer-job-complete`.
