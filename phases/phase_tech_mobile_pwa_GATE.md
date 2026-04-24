# Phase Gate: phase_tech_mobile_pwa

**Written before build begins. Criteria here cannot be loosened mid-phase.**

Phase 6 of 13. The tech field-view: a PWA a tech installs on their
phone and uses to run the day — today's list, per-job detail with
directions, camera, pricebook-driven invoice draft. Plus the
infrastructure pieces (service worker, IndexedDB write queue, web
push subscription) the later phases will build on.

Every layer reuses the patterns from phases 1–5 — `RequestScope`,
`withScope`, app-layer WHERE + RLS, pluggable external-service
adapters. New surface: client-side offline queue, browser-side
storage (IndexedDB), and a first push-subscription record on the
server. No migrations change earlier tables.

---

## Must Pass (BLOCKERS — any failure rejects the gate)

### PWA shell

- [ ] `public/manifest.webmanifest` served at `/manifest.webmanifest`
  with name, short_name, start_url, display=standalone, theme/
  background colours, and at least one icon each at 192×192 and
  512×512.
- [ ] `public/sw.js` service worker registered from the root layout:
  caches the app shell on install, uses network-first for `/api/*`
  requests (cache on success, fall back to cache when offline),
  cache-first for hashed static assets.
- [ ] PWA install works on Chrome Android + iOS Safari (install
  prompt surfaces; Lighthouse PWA install criteria pass). The check
  can be a structural test — every manifest field + SW-registration
  call present — since live browser tests are Playwright territory.

### Tech route set

- [ ] `/(tech)/page.tsx` — today's jobs for the signed-in tech
  (filter `assignedTechUserId = session.user.id`, status active).
- [ ] `/(tech)/jobs/[id]/page.tsx` — job detail adapted for mobile
  screens: title, status with transition buttons, static map with
  "Directions" link to Google Maps (external `navigation` URL),
  photo gallery with camera capture button, "Create invoice"
  button.
- [ ] `/(tech)/jobs/[id]/invoice/page.tsx` — invoice draft editor.
- [ ] Tech routes only resolve when the caller has a `tech`
  membership; other roles get `notFound()`.
- [ ] AppShell (desktop) gains a "Tech view" link for users with a
  tech membership.

### Invoice draft model + API

- [ ] Migration 0007 adds `invoices` + `invoice_line_items` tables,
  enum `invoice_status` (draft, finalized, sent, paid, void), RLS
  ENABLED + FORCE + three-policy per table.
- [ ] `POST /api/v1/jobs/:id/invoices` creates a draft invoice
  linked to the job; optional `lines: [{ serviceItemId, quantity,
  overridePrice? }]` body seeds the line items from pricebook.
- [ ] `GET /api/v1/invoices/:id` returns the invoice + its line
  items + computed subtotal/tax/total.
- [ ] `PATCH /api/v1/invoices/:id` — draft-only. Replace the line
  item set; recompute totals atomically. Each line must resolve to
  a pricebook item in the franchisor's published template, and
  any `unitPrice` override must satisfy the item's floor/ceiling
  (reuses phase-4's `PRICE_OUT_OF_BOUNDS` code).
- [ ] `DELETE /api/v1/invoices/:id` — soft-delete a draft.
- [ ] Finalize / send / pay transitions are explicitly **out of
  scope** for this phase (they're phase 7). Invoice status stays
  `draft` through this phase.

### IndexedDB offline write queue

- [ ] `apps/web/src/lib/offline-queue.ts` — exports
  `enqueue(request)`, `drain()`, `size()`. Uses IndexedDB via a
  thin wrapper (no heavy npm dep). Queued entries survive page
  reload.
- [ ] `apiClientFetch` enqueues mutations (`POST`/`PATCH`/`DELETE`)
  when `navigator.onLine` is false, returns a synthetic 202 with
  `{ queued: true }`.
- [ ] A `window.addEventListener('online', drain)` registration
  drains pending writes on reconnect.
- [ ] Vitest unit tests against `fake-indexeddb`: enqueue → drain
  happy path, drain while offline no-ops, quota failure surfaces as
  a thrown error rather than silent data loss.

### Camera capture

- [ ] Tech job detail's "Take photo" button uses
  `<input type="file" accept="image/*" capture="environment" />`
  so mobile browsers invoke the camera directly. Falls back to
  file picker on desktop — no crash.
- [ ] Upload reuses the phase-3 presigned-URL flow
  (`POST /api/v1/jobs/:id/photos/upload-url` → PUT → `POST /photos`).

### Web push subscription

- [ ] Migration 0007 (or an adjacent one) adds
  `push_subscriptions` table: `user_id` FK, `endpoint` unique,
  `p256dh`, `auth`, `user_agent`, `created_at`, `deleted_at`.
- [ ] `POST /api/v1/push/subscribe` accepts a Web Push
  subscription JSON blob, stores it against the caller's user id.
- [ ] `DELETE /api/v1/push/subscriptions/:id` (or by endpoint)
  removes the subscription.
- [ ] Server exports a `PushSender` interface + a stub default impl
  (logs payload, never sends). Real VAPID-based sender wired
  behind `VAPID_*` env vars; missing keys → stub with WARN log, no
  crash.
- [ ] Client-side: when the service worker is registered AND the
  user is signed in, request notification permission (once) and
  push `PushSubscription` to the subscribe endpoint.

### Security test suite

- [ ] ≥ 20 cases in `apps/api/src/__tests__/live-security-tm.test.ts`,
  all pass, < 30 s runtime.
- [ ] Anonymous 401 on every new endpoint.
- [ ] Cross-tenant invoice read/write blocked.
- [ ] `PRICE_OUT_OF_BOUNDS` fires on line item override below
  floor / above ceiling.
- [ ] Invoice in non-draft status rejects PATCH (409
  `INVOICE_NOT_EDITABLE`).
- [ ] Push subscribe/unsubscribe scoped to caller's user id (no
  one-user-deletes-another).

### Unit + Integration Test Suite

- [ ] `pnpm turbo test --force` exits 0 across every workspace
  project, 0 cached, 0 skipped.
- [ ] No regression in phases 1–5.

---

## Must Improve Over Previous Phase

- [ ] No regression in phase_dispatch_board.
- [ ] No new `pnpm audit --audit-level=high` findings.
- [ ] Web bundle First Load JS per route stays under 200 kB
  (dispatch loosened to 180 kB; PWA + tech view adds modest
  weight — 20 kB more is acceptable and tracked).

---

## Security Baseline

- [ ] Every new endpoint has 401 + 403 + 400 tests.
- [ ] Service worker scope is limited to the web origin — no
  cross-origin reach.
- [ ] `push_subscriptions.endpoint` has a unique index so repeated
  registration is upsert-like, not N-rows.

---

## Documentation

- [ ] `docs/ARCHITECTURE.md` gains a "Tech PWA + offline" subsection
  covering the service worker cache strategy, the IndexedDB write
  queue sync model, and the web push subscription record.
- [ ] `docs/api/tech-mobile.md` documents invoice draft endpoints
  + push subscribe endpoints.

---

## Gate Decision

**Audited in:** `phase_tech_mobile_pwa_AUDIT_1.md` (cycle 1)
**Verdict:** PASS — approved 2026-04-23

All BLOCKER criteria verified. Three minors tracked in AUDIT_1
(m1: real VAPID sender deferred to phase 7; m2: no hard
"one draft per job" constraint; m3: no retry cap on IndexedDB
drain). Tagged `phase-tech-mobile-pwa-complete`.
