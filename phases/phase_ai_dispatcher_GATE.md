# Phase Gate: phase_ai_dispatcher

**Written before build begins. Criteria here cannot be loosened mid-phase.**

Phase 10 of 13. The AI dispatcher: given a franchisee's current
unassigned jobs + tech roster + live load + travel times, the
agent proposes assignments. Confidence above threshold →
auto-apply; below → queue for human review with reasoning. The
human dispatcher one-clicks to approve or reject.

Every new piece reuses the patterns from prior phases — pluggable
Distance Matrix adapter (Google in prod, deterministic stub in
dev/tests), agent loop from phase 9, 3-policy RLS, admin-gated
mutations. No migrations to earlier tables.

**After this phase, a pilot franchisee's dispatcher can open the
board in the morning and see seven jobs already assigned with
confidence and three queued for approval — each with a plain-
English reason.**

---

## Must Pass (BLOCKERS — any failure rejects the gate)

### Data model (migration 0011)

- [ ] `ai_suggestions` table: `id`, `franchisee_id`,
  `conversation_id` (FK ai_conversations), `kind` enum
  ('assignment'), `subject_job_id`, `proposed_tech_user_id`,
  `proposed_scheduled_start?`, `reasoning` (text),
  `confidence` numeric(5,4), `status` enum ('pending',
  'approved', 'rejected', 'applied', 'expired'), `created_at`,
  `decided_at?`, `decided_by_user_id?`.
- [ ] `ai_metrics` table: `id`, `franchisee_id`, `date`
  (DATE), `suggestions_total`, `auto_applied`, `queued`,
  `approved`, `rejected`, `override_rate` numeric(5,4).
  Unique on `(franchisee_id, date)`.
- [ ] `tech_skills` table: `user_id` (FK users, scoped via
  memberships), `franchisee_id`, `skill` (text), `created_at`.
  Primary key `(user_id, franchisee_id, skill)`.
- [ ] `franchisees.ai_guardrails` gets a `dispatcherAutoApplyThreshold`
  key (default 0.8). The existing jsonb schema default is
  updated so new franchisees inherit the dispatcher threshold
  along with CSR guardrails.
- [ ] `.down.sql` reversible.

### Distance matrix adapter

- [ ] `DistanceMatrixClient` interface: `estimate(origin, dest,
  mode='driving')` → `{ durationSeconds, distanceMeters }`.
  Stub computes a deterministic estimate from lat/lng
  haversine (35 mph fallback when speeds aren't known) so
  scheduling tests are reproducible. Real impl wraps Google
  Distance Matrix, keyed by `GOOGLE_MAPS_API_KEY`.
- [ ] `resolveDistanceMatrixClient()` falls back to stub when
  the key is unset.

### Dispatcher tools

- [ ] Six tools in `apps/api/src/ai-tools/dispatcher-tools.ts`:
  - `listUnassignedJobs({ limit? })` — jobs in the caller's
    franchisee with `status = 'unassigned'` and `deletedAt IS
    NULL`; includes customer lat/lng + scheduled window.
  - `listTechs({ skill? })` — active tech memberships, joined
    with `tech_skills` when `skill` is passed.
  - `getTechCurrentLoad({ techUserId })` — count of today's
    scheduled + in-progress jobs, plus last job end time for
    travel-time anchor.
  - `computeTravelTime({ fromLat, fromLng, toLat, toLng })` —
    wraps the DistanceMatrix adapter.
  - `proposeAssignment({ jobId, techUserId, scheduledStart,
    reasoning, confidence })` — does NOT write; returns a
    `ProposedAssignment` record the caller persists.
  - `applyAssignment({ suggestionId })` — applies a pending
    suggestion (invokes the phase-5 `/assign` pathway via a
    scoped helper). Returns the assigned job row.
- [ ] Tools enforce scope via `ctx.franchiseeId`; cross-tenant
  arguments → `INVALID_TARGET`.
- [ ] ≥ 12 unit / live tests across the tool suite.

### Dispatcher agent runner

- [ ] `runDispatcher({ franchiseeId, ctx })` wraps
  `runAgentLoop` with the dispatcher tool set + a dispatcher
  system prompt (new `packages/ai/prompts/dispatcher.ts`).
- [ ] For each `proposeAssignment` the agent emits, the runner
  inserts an `ai_suggestions` row. If `confidence >=
  threshold` AND the assignment passes scheduling invariants
  (no double-book, tech has required skill, within travel
  budget), status = `applied` + the underlying job is
  re-assigned in one transaction; otherwise status =
  `pending`.
- [ ] Scheduling invariants:
  - Tech cannot be double-booked for the proposed window.
  - When a job has a `requiredSkill` (phase 10 adds this
    optional field? keep it on the suggestion shape only —
    a later phase attaches skills to jobs), the tech must have
    it in `tech_skills`.
  - Travel time from tech's previous job location must fit
    inside the gap before the proposed start.

### Suggestions API

- [ ] `POST /api/v1/dispatch/suggest` — triggers the runner
  for the caller's franchisee. Dispatcher / franchisee_owner /
  admin only; tech / CSR → 403.
- [ ] `GET /api/v1/dispatch/suggestions?status=pending` —
  lists suggestions for the caller's franchisee.
- [ ] `POST /api/v1/dispatch/suggestions/:id/approve` — applies
  the suggestion; flips status `pending → applied` + writes
  `decided_at` / `decided_by_user_id`.
- [ ] `POST /api/v1/dispatch/suggestions/:id/reject` — flips to
  `rejected` without touching the job.
- [ ] Approve of a stale suggestion whose target job is already
  assigned → `409 STALE_SUGGESTION`.

### Dispatch board UI

- [ ] `/dispatch` page gains an "AI suggestions" column with
  pending rows: job title, proposed tech, reasoning,
  confidence bar, Approve + Reject buttons.
- [ ] Approve / reject fire the API and optimistically remove
  the row; rollback on failure.
- [ ] A "Suggest assignments" button triggers the run; button
  disables while running.

### Cancellation reflow + metrics

- [ ] Job transition to `canceled` emits `job.canceled` on the
  EventBus; the dispatcher agent subscribes and re-queues
  affected assignments into `pending` suggestions (no
  auto-apply for reflow — always human-review first).
- [ ] `ai_metrics` daily rollup computed by a pure function
  `computeDailyAiMetrics({ tx, franchiseeId, date })` that
  reads `ai_suggestions` and writes one `ai_metrics` row
  upserted on `(franchisee_id, date)`.
- [ ] `GET /api/v1/dispatch/metrics?date=YYYY-MM-DD` — returns
  the metrics for the franchisee on the given day.

### Security test suite

- [ ] ≥ 20 cases in `apps/api/src/__tests__/live-security-di.test.ts`,
  < 30 s runtime.
- [ ] Anonymous 401 on every new endpoint.
- [ ] Tech / CSR cannot trigger the runner → 403.
- [ ] Cross-tenant approve / reject → 404 (no existence leak).
- [ ] Scheduling correctness: double-book rejected, missing
  skill rejected, travel-budget overflow rejected.

### Unit + integration tests

- [ ] `pnpm turbo test --force` → 0 cached, 0 skipped.
- [ ] No regression in phases 1–9.

---

## Must Improve Over Previous Phase
- [ ] No regression in phase_ai_csr_voice.
- [ ] No new `pnpm audit --audit-level=high` findings.
- [ ] `/dispatch` route's First Load JS stays under 200 kB even
  with the new column.

---

## Security Baseline
- [ ] Every new API endpoint has 401 + 403 + 400 tests.
- [ ] Dispatcher tools cannot read or mutate cross-franchisee
  data — context is always server-resolved from
  `request.scope`.
- [ ] Applying a suggestion runs under the original
  franchisee's RLS scope; a pending suggestion owned by
  another franchisee is never visible.

---

## Documentation
- [ ] `docs/ARCHITECTURE.md` section 6h "AI dispatcher" covers
  the 6-tool set, auto-apply vs queue logic, scheduling
  invariants, metrics rollup, cancellation reflow.
- [ ] `docs/api/ai-dispatcher.md` documents every new endpoint.

---

## Gate Decision

**Audited in:** `phase_ai_dispatcher_AUDIT_1.md` (cycle 1)
**Verdict:** PASS — approved 2026-04-24

All BLOCKER criteria verified. Three minors tracked in AUDIT_1
(m1: skill match uses reasoning-string convention; m2: no
auto-re-suggest on reflow; m3: hard-coded 15-min travel
buffer). Tagged `phase-ai-dispatcher-complete`.
