# Phase Gate: phase_dispatch_board

**Written before build begins. Criteria here cannot be loosened mid-phase.**

Phase 5 of 13. Gives dispatchers a live, drag-drop dispatch board
driven by the jobs + memberships models phases 2/3 already ship. Adds
an in-process EventBus + Server-Sent Events so moves propagate to
every open session in under 500 ms. Also lands the first Google Maps
embed (job detail static map).

Reuses the proven patterns — `requireScope`, `withScope`, app-layer
WHERE + RLS, pluggable external-service adapters — without
modification.

---

## Must Pass (BLOCKERS — any failure rejects the gate)

### Assignment API + EventBus

- [ ] `POST /api/v1/jobs/:id/assign` — body
  `{ assignedTechUserId, scheduledStart?, scheduledEnd? }`.
  Validates the tech user belongs to the job's franchisee; rejects
  cross-franchisee assignments with `400 INVALID_TARGET`.
- [ ] When assigning a job currently `unassigned` the handler
  auto-transitions it to `scheduled` and writes a `job_status_log`
  row in the same transaction.
- [ ] `POST /api/v1/jobs/:id/unassign` clears `assigned_tech_user_id`
  (and optionally returns the job to `unassigned` status when it was
  `scheduled` with no schedule times set).
- [ ] Publishes `job.assigned` / `job.unassigned` / `job.transitioned`
  events to an injectable `EventBus` interface; in-process default
  impl is a simple Node `EventEmitter` wrapper; a Redis-backed impl
  can slot in later without touching handlers.
- [ ] Every endpoint requires an active scope; uses the defence-in-
  depth combo (requireScope + withScope + app-layer WHERE).

### SSE live update stream

- [ ] `GET /api/v1/jobs/events/stream` returns
  `text/event-stream` (keep-alive, no buffering).
- [ ] Subscribes the caller to the `EventBus`; writes one SSE `data:`
  frame per matching event. Events are filtered to the caller's
  scope (franchisee sees their own, franchisor sees their franchisor's
  franchisees, platform sees everything).
- [ ] Heartbeat comment frame every 15 seconds so proxies don't close
  idle connections.
- [ ] End-to-end integration test: open stream as a franchisee user,
  POST an assignment, assert the event is received in < 500 ms.

### Dispatch board UI (dnd-kit)

- [ ] `/(app)/dispatch` — server-rendered initial state plus a client
  subtree that opens the SSE stream. Guarded to franchisee-scoped
  users (platform / franchisor without an impersonation see 404 —
  the board only makes sense inside one franchisee at a time).
- [ ] Columns: **Unassigned** on the left, then one column per tech
  in the caller's franchisee (users with role `tech`). Each column
  shows the jobs currently assigned to that tech for the selected
  date.
- [ ] Drag a job card from one column to another → POST
  `/api/v1/jobs/:id/assign`; optimistic UI moves the card
  immediately, SSE event confirms + any conflicting move wins
  last-write.
- [ ] Date picker defaults to today; changing it re-fetches board
  state.
- [ ] SSE subscription auto-refreshes the board when events arrive
  from other sessions; keep state within 500 ms of source.

### Static Google Maps on job detail

- [ ] `<StaticMap />` component renders a Google Static Maps image
  when the job's customer has `latitude` + `longitude`.
- [ ] Uses `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` when set; otherwise
  renders a placeholder with the coordinates and no image (no build
  failure, no crash).
- [ ] Embedded above the photo gallery on `/(app)/jobs/[id]`.

### SSE latency harness

- [ ] Live-Postgres test opens **10 concurrent** SSE subscriptions,
  fires a single assignment event, records time-to-receive per
  subscriber, asserts **p95 < 500 ms**. Skips when `DATABASE_URL` is
  unreachable like every other live test.

### Security test suite

- [ ] ≥ 20 cases in `apps/api/src/__tests__/live-security-db.test.ts`,
  all pass, < 30 s runtime.
- [ ] Anonymous 401 on every new endpoint.
- [ ] Cross-tenant assignment blocked (`400 INVALID_TARGET` for tech
  in another franchisee).
- [ ] Assigning a non-existent tech id → 400.
- [ ] Assigning to a user whose role isn't `tech` → 400.
- [ ] SSE stream events are filtered by scope (denver dispatcher
  never sees austin job.assigned events).

### Unit + Integration Test Suite

- [ ] `pnpm turbo test --force` exits 0 across every workspace
  project, 0 cached, 0 skipped.
- [ ] No regression in phases 1–4 (544 tests still pass).

---

## Must Improve Over Previous Phase

- [ ] No regression in phase_pricebook.
- [ ] No new `pnpm audit --audit-level=high` findings.
- [ ] Web bundle First Load JS per route stays under 180 kB (dnd-kit
  adds weight — loosening the ceiling by 30 kB from prior phases is
  acceptable and tracked).

---

## Security Baseline (inherited + tightened)

- [ ] Every new endpoint has 401 + 403 + 400 tests.
- [ ] SSE stream close-on-logout verified.
- [ ] No secrets leak via the events — payloads carry ids only, not
  full job/customer objects.

---

## Documentation

- [ ] `docs/ARCHITECTURE.md` gains a "Dispatch + realtime" section
  describing the EventBus interface, SSE scope filtering, and the
  last-write-wins conflict model.
- [ ] `docs/api/dispatch.md` documents assign / unassign / SSE with
  event payload shapes.

---

## Gate Decision

**Verdict:** APPROVED

**Reviewer:** Joey Heinrichs (self-review against AUDIT_1)
**Date:** 2026-04-23
**Commit:** security-suite commit + docs/approval commit on top
**Notes:** Every BLOCKER criterion is independently verified in
`phase_dispatch_board_AUDIT_1.md` against the live docker Postgres
stack. 587 tests across 9 packages, 0 cached, 0 skipped. 10-
subscriber SSE latency harness beat the 500 ms p95 budget. Zero
bugs surfaced during the run — the tenancy + adapter patterns
from earlier phases carried over cleanly to assignment, EventBus,
and the SSE stream. Three minors carried forward:
single-franchisee dispatch view (platform/franchisor use
impersonation), no Redis-backed EventBus yet (interface in
place), assignment allowed from any scoped user (policy
recorded in the security suite so a future tightening flips a
positive to a negative case). Tagged `phase-dispatch-board-complete`.
