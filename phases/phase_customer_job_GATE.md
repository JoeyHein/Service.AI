# Phase Gate: phase_customer_job

**Written before build begins. Criteria here cannot be loosened mid-phase.**

Phase 3 of 13. Builds on the tenancy primitives proven in phase 2
(`RequestScope`, `withScope`, RLS policies, invite/impersonate flows).
Ships the trade-agnostic backbone every subsequent phase reads from:
customers, jobs, status history, photos. Uses the same defence-in-depth
pattern (app-layer scope WHERE + RLS) established in TEN-03/TEN-10.

---

## Must Pass (BLOCKERS — any failure rejects the gate)

### Schema & Migrations

- [ ] Tables present: `customers`, `jobs`, `job_status_log`, `job_photos`
  - **Verification:** `grep pgTable packages/db/src/schema.ts` shows all four
- [ ] Enum `job_status` defined with values `unassigned`, `scheduled`,
  `en_route`, `arrived`, `in_progress`, `completed`, `canceled`
- [ ] Migration 0005 applies and reverts cleanly against fresh Postgres 16
- [ ] Every FK has an index; every tenant table has `franchisee_id`
  NOT NULL + `created_at` + `updated_at`
- [ ] RLS ENABLED + FORCE on every new table with three policies each
  (platform / franchisor / scoped) matching the 0003 pattern

### Customers API

- [ ] `POST /api/v1/customers` — validates input, rejects cross-tenant
  location ids, returns 201 with the new row
- [ ] `GET /api/v1/customers` — list with `search`, `limit`, `offset`
  (defaults 50/0), returns `{ rows, total, limit, offset }`
- [ ] `GET /api/v1/customers/:id` — 404 when not in scope
- [ ] `PATCH /api/v1/customers/:id` — partial update, returns the
  updated row
- [ ] `DELETE /api/v1/customers/:id` — soft-delete (sets `deleted_at`),
  idempotent (second call returns `alreadyDeleted: true`)
- [ ] Every endpoint requires an active scope and calls `withScope` +
  explicit app-layer WHERE clause

### Jobs API + status state machine

- [ ] `POST /api/v1/jobs` — requires a customer in the same franchisee,
  initial status = `unassigned`, returns the new job
- [ ] `GET /api/v1/jobs` — filter by `customerId`, `status`,
  `assignedTechUserId`, pagination as per customers
- [ ] `GET /api/v1/jobs/:id` — 404 when not in scope
- [ ] `PATCH /api/v1/jobs/:id` — partial update for non-status fields
- [ ] `POST /api/v1/jobs/:id/transition` — body `{ toStatus, reason? }`,
  enforces the transition matrix (rejects invalid transitions with
  409 INVALID_TRANSITION), writes one `job_status_log` row inside a
  transaction with the update so status + log never drift
- [ ] Transition matrix enforced:
  - `unassigned` → `scheduled`, `canceled`
  - `scheduled`  → `en_route`, `unassigned`, `canceled`
  - `en_route`   → `arrived`, `canceled`
  - `arrived`    → `in_progress`, `canceled`
  - `in_progress`→ `completed`, `canceled`
  - `completed`  → (terminal)
  - `canceled`   → (terminal)

### Google Places integration

- [ ] `PlacesClient` interface exported from a dedicated module with
  `autocomplete(query)` + `details(placeId)` methods
- [ ] Dev/test impl (`stubPlacesClient`) returns 3 deterministic
  address candidates for any query — no network calls
- [ ] Production impl wires `@googlemaps/google-maps-services-js`
  behind `GOOGLE_MAPS_API_KEY`; absence of key does not crash the app
- [ ] `GET /api/v1/places/autocomplete?q=...` returns candidate list
- [ ] `GET /api/v1/places/:placeId` returns resolved address + coords
- [ ] Every Places endpoint requires an authenticated scope

### Photo upload (DO Spaces)

- [ ] `ObjectStore` interface exported with `getUploadUrl(key, ct)` +
  `getDownloadUrl(key)` methods
- [ ] Dev/test impl returns fake presigned URLs with no network calls
- [ ] Production impl wires `@aws-sdk/s3-request-presigner` behind
  `DO_SPACES_*` env vars
- [ ] `POST /api/v1/jobs/:id/photos/upload-url` returns
  `{ uploadUrl, storageKey, expiresAt }`; the key is deterministic
  under `jobs/<jobId>/photos/<uuid>.<ext>`
- [ ] `POST /api/v1/jobs/:id/photos` finalises the record with
  `{ storageKey, contentType, sizeBytes, label? }`, writes to
  `job_photos`, returns the inserted row + a download URL
- [ ] `DELETE /api/v1/jobs/:id/photos/:photoId` removes the record
  (storage cleanup is out of v1 scope — noted in TECH_DEBT)
- [ ] Every photo endpoint checks the job is in scope before acting

### Web UI

- [ ] `/(app)/customers` — list with search field + page navigation
- [ ] `/(app)/customers/new` — create form with Places autocomplete
  client component; submits `POST /api/v1/customers` and redirects
  to `/customers/[id]`
- [ ] `/(app)/customers/[id]` — detail view + edit form
- [ ] `/(app)/jobs` — list with status filter + page navigation
- [ ] `/(app)/jobs/new` — create form bound to a customer dropdown
- [ ] `/(app)/jobs/[id]` — detail view showing current status,
  transition buttons filtered to valid next states, photo gallery,
  photo upload control
- [ ] All protected routes go through `requireSession` and render
  their content server-side; no session leaks to client bundles

### Security test suite (live Postgres)

- [ ] ≥25 test cases in `apps/api/src/__tests__/live-security-cj.test.ts`,
  all pass, runtime < 30s
- [ ] Anonymous access returns 401 on every new endpoint
- [ ] Cross-tenant IDOR: denver dispatcher querying austin customers or
  jobs by id returns 404; listing returns 0 rows
- [ ] Non-existent ids return 404 even when scope would match
- [ ] Invalid state transitions return 409 INVALID_TRANSITION
- [ ] Creating a job with a customer in a different franchisee returns
  400 INVALID_TARGET
- [ ] Photos endpoint rejects uploads to jobs outside scope
- [ ] Per-role authorization: franchisee_owner can do everything in
  their franchisee; dispatcher can create + transition; tech can
  transition assigned jobs only (or read-all if simpler — note the
  choice inline)

### Unit + Integration Test Suite

- [ ] `pnpm turbo test --force` exits 0 across every workspace project
  with 0 cached
- [ ] No new skips except DATABASE_URL-gated ones, documented inline

---

## Must Improve Over Previous Phase

- [ ] No regression in `phase_tenancy_franchise` tests
- [ ] No new `pnpm audit --audit-level=high` findings
- [ ] Web bundle First Load JS stays under 150 kB per route

---

## Security Baseline (inherited + tightened)

- [ ] Every new endpoint has 401 + 403 + 400 tests
- [ ] No SQL string concatenation introduced
- [ ] Presigned upload URLs are short-lived (≤15 min) and scoped to
  a specific storage key

---

## Documentation

- [ ] `docs/ARCHITECTURE.md` gains a "Customer / job model" section
  with table overview + status state machine diagram
- [ ] `docs/api/customer-job.md` documents every new endpoint
- [ ] `CLAUDE.md` Required Patterns gains a "Status state machines"
  sub-section pointing at the transition matrix pattern

---

## Gate Decision

_(Filled in by reviewer after all BLOCKER criteria are verified)_

**Verdict:** _(pending)_
