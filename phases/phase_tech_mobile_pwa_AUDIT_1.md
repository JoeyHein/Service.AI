# Audit: phase_tech_mobile_pwa — Cycle 1

**Audited at:** 2026-04-23
**Commit:** TM-07 security suite + docs/approval commit
**Auditor:** self-audit by phase builder against the pre-written gate
**Prior corrections applied:** none (first audit after phase work completed)

---

## Context

Phase 6 of 13. Phase work ran from TM-05a (invoice schema + API)
through TM-07 (security suite). Seven implementation tasks plus a
docs/approval commit — nine commits total (gate + 7 tasks + docs
tag). Same autonomous-run discipline as phases 3 / 4 / 5: mocked
tests where they help + live-Postgres integration per task.

New surface added this phase:

1. **Invoice draft model + API** — `invoices` + `invoice_line_items`
   tables, POST/GET/PATCH/DELETE endpoints, server-side
   subtotal/tax/total derivation, bounds + publish-status gating.
   Finalise / send / pay transitions are deferred to phase 7.
2. **PWA shell** — `public/manifest.webmanifest`, `public/sw.js`
   service worker (network-first for routes + /api/*, cache-first
   for `/_next/static/*`), root-layout registration component.
3. **Tech route set** — `/tech`, `/tech/jobs/[id]`,
   `/tech/jobs/[id]/invoice` behind a membership gate that `notFound`s
   any role other than `tech`. Mobile-first chrome in `TechShell`.
4. **IndexedDB offline write queue** — `offline-queue.ts` with
   enqueue/drain/size/list, FIFO ordering, 4xx-deletes-5xx-retries
   semantics, and an `OfflineQueueDrainer` that reattaches on
   every `online` event.
5. **Camera capture** — `capture="environment"` on the JobPhotos
   file input; desktop falls back automatically.
6. **Web push subscription** — `push_subscriptions` table (plus a
   `user_id = app.user_id` RLS self-scope after extending `withScope`
   to propagate the authenticated user id), POST/DELETE endpoints,
   pluggable `PushSender` + `stubPushSender` default, client-side
   PushSubscribe hook guarded by NEXT_PUBLIC_VAPID_PUBLIC_KEY.
7. **Invoice draft editor** — pricebook picker + line editor with
   client-side bounds feedback + server-authoritative totals.

---

## Summary

**Every gate criterion is met.** 652 tests across 9 packages, 0
cached, 0 skipped, total runtime ~90 s under `pnpm turbo test
--force`. Zero bugs caught mid-phase — the defence-in-depth
tenancy combo carried over cleanly; one TypeScript narrowing bump
in the Push BufferSource cast was the only rough edge.

The new security suite (`live-security-tm.test.ts`) contributes
23 cases in ~2 s runtime, well under the ≤30 s gate budget.

---

## Gate criterion verification

### PWA shell
- [x] `public/manifest.webmanifest` served with name, short_name,
  start_url, display=standalone, theme/background colours, icons
  at 192×192 and 512×512.
- [x] `public/sw.js` registered from the root layout. Install
  pre-caches the shell, activate purges old versions, fetch uses
  network-first for routes + `/api/*` and cache-first for hashed
  static assets. Scope is same-origin only.
- [x] Lighthouse-equivalent structural test locks all manifest
  fields, both icons, SW lifecycle handlers, and cache strategy.

### Tech route set
- [x] `/tech` today-view filters on `assignedTechUserId =
  session.user.id`, drops completed/canceled, sorts by scheduled
  start.
- [x] `/tech/jobs/[id]` mobile job detail with Directions
  (Google Maps navigation URL), static map, transition panel,
  photo gallery, Create-invoice button.
- [x] `/tech/jobs/[id]/invoice` full line editor.
- [x] Tech routes gated on `scope.type === 'franchisee' &&
  scope.role === 'tech'`; other roles `notFound()`.
- [x] AppShell gains a "Tech view" link when the caller has a
  tech scope.

### Invoice draft model + API
- [x] Migration 0007 adds `invoices`, `invoice_line_items`,
  `push_subscriptions` tables + `invoice_status` enum. Three-policy
  RLS pattern on the tenant-scoped tables; user-scoped RLS on
  `push_subscriptions` driven by the new `app.user_id` GUC.
- [x] `POST /api/v1/jobs/:id/invoices` creates a draft bound to
  the job's franchisee/customer; optional `lines` seeds line items.
- [x] `GET /api/v1/invoices/:id` returns the invoice + lines.
- [x] `PATCH /api/v1/invoices/:id` replaces line set atomically,
  recomputes totals, rejects non-draft with 409 INVOICE_NOT_EDITABLE.
  Line overrides are re-validated against floor / ceiling.
- [x] `DELETE /api/v1/invoices/:id` soft-deletes; replay returns
  `{ alreadyDeleted: true }`.
- [x] Finalize / send / pay transitions explicitly NOT implemented
  this phase.

### IndexedDB offline write queue
- [x] `apps/web/src/lib/offline-queue.ts` exports `enqueue`,
  `drain`, `size`, `list`, `clear`, `defaultSender`.
- [x] `apiClientFetch` enqueues mutations when `navigator.onLine`
  is false, returns synthetic 202 `{ queued: true }`.
- [x] `OfflineQueueDrainer` attaches a single
  `window.addEventListener('online', drain)`.
- [x] Vitest unit tests against `fake-indexeddb` cover enqueue
  → drain, FIFO ordering, 4xx vs 5xx handling, offline no-op,
  validation, and persistence across reopen.

### Camera capture
- [x] Tech job detail's "Take photo" button uses
  `<input type="file" accept="image/*" capture="environment" />`.
- [x] Desktop falls back to file picker (browsers ignore
  `capture` without a camera); no crash path.
- [x] Upload reuses the phase-3 presigned-URL flow.

### Web push subscription
- [x] Migration 0007 adds `push_subscriptions` table with unique
  partial endpoint index, user FK, denormalised franchisee id.
- [x] `POST /api/v1/push/subscribe` upserts; same-endpoint /
  different-user soft-deletes the previous owner.
- [x] `DELETE /api/v1/push/subscriptions/:id` + `DELETE
  /api/v1/push/subscribe` by endpoint, both scoped to the caller.
- [x] `PushSender` interface + `stubPushSender` default; VAPID
  env vars trigger real sender hook (real sender wired in
  phase 7). Missing keys → stub with WARN.
- [x] Client-side `PushSubscribe` asks for Notification
  permission once and POSTs the subscription when
  NEXT_PUBLIC_VAPID_PUBLIC_KEY is set.

### Security test suite
- [x] 23 cases in `live-security-tm.test.ts`, all pass, ~2 s
  runtime.
- [x] Anonymous 401 on every new endpoint (POST/GET/PATCH/DELETE
  invoices × 4, POST/DELETE push × 2).
- [x] Cross-tenant invoice read/write blocked (create + GET +
  PATCH + DELETE cross-franchisee → 404).
- [x] `PRICE_OUT_OF_BOUNDS` fires on POST + PATCH below floor /
  above ceiling.
- [x] `INVOICE_NOT_EDITABLE` on PATCH + DELETE when status =
  'finalized' (set via direct SQL since finalize lives in phase 7).
- [x] Push subscribe/unsubscribe scoped to caller's user id;
  cross-user delete by id and by endpoint → 404.

### Unit + Integration test suite
- [x] `pnpm turbo test --force` → 652 tests across 9 packages,
  0 cached, 0 skipped.
- [x] No regression in phases 1–5 (587 existing tests still
  pass; +65 new tests this phase).

---

## Must Improve Over Previous Phase

- [x] No regression in phase_dispatch_board (all prior SSE /
  assignment / techs tests still pass).
- [x] No new `pnpm audit --audit-level=high` findings (5 moderate
  remain, same as phase 5; zero high).
- [x] Web bundle First Load JS: tech routes land at 107–109 kB,
  invoice route 109 kB — well under the 200 kB ceiling and the
  loosened 180 kB dispatch ceiling.

---

## Security Baseline

- [x] Every new endpoint has 401 + 404/409 + 400 tests.
- [x] Service worker scope is limited to the web origin; no
  cross-origin reach.
- [x] `push_subscriptions.endpoint` has a unique partial index
  (`WHERE deleted_at IS NULL`) so repeated registration is
  upsert-like, not N-rows.

---

## Documentation

- [x] `docs/ARCHITECTURE.md` gains section 6d "Tech PWA + offline"
  covering the SW cache strategy, IndexedDB outbox semantics, and
  push subscription record.
- [x] `docs/api/tech-mobile.md` documents every new endpoint with
  body shapes + error-code matrix.

---

## BLOCKERS
**Zero.**

## MAJORS
**None.**

## MINORS (carried forward, non-blocking)

### m1. Real VAPID sender not wired yet

`resolvePushSender()` detects VAPID env vars but still returns
the stub — the real sender (web-push library + JWT signing) lands
in phase 7 alongside the first actual push trigger (invoice
finalise / tech dispatch notification). Interface is fixed, so
swapping the impl is additive.

### m2. One draft per job invariant is not enforced

The POST endpoint lets a tech create multiple drafts for the
same job. v1 tolerates this — the client only ever shows the most
recent one and phase 7's finalise flow will cascade-soft-delete
the siblings. If we want a hard constraint, a partial unique
index on `(job_id) WHERE status = 'draft' AND deleted_at IS NULL`
is a one-line migration.

### m3. IndexedDB drain has no per-entry retry counter

A 5xx that persists across many reconnect cycles currently retries
forever (same entry, over and over). For the tech-scale workload
this is fine — the outbox rarely holds more than a handful of
entries — but if we ever support bulk mutation we'll want a
`retryCount` + exponential backoff, enforced via a dead-letter
move after N attempts.

---

## Verdict: PASS

Every BLOCKER criterion is live-verified. Three minors are explicit
trade-offs. Ready for gate approval and the tag
`phase-tech-mobile-pwa-complete`.
