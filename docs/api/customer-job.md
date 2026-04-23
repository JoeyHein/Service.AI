# Customer + Job API (phase_customer_job)

All endpoints return the canonical envelope:

```ts
{ ok: true, data: T } | { ok: false, error: { code: string, message: string } }
```

Anonymous callers get `401 UNAUTHENTICATED`. All endpoints require an
active scope (`req.requireScope()`); franchisee-scoped callers only
see rows in their franchisee, franchisor admins see their whole
franchisor, platform admins see everything.

Source of truth: `apps/api/src/{customers-routes,jobs-routes,job-photos-routes,places,franchisees-routes}.ts`.

---

## Customers

### `POST /api/v1/customers`

Creates a customer. `franchiseeId` is derived from `request.scope`
(franchisee-scoped caller) or from `locationId` (platform / franchisor
admin — `locationId` is required for them so the target franchisee is
unambiguous). Cross-franchisor + cross-franchisee `locationId` values
are rejected with `400 INVALID_TARGET`.

**Body:**

```ts
{
  name: string,                      // required, ≤200 chars
  email?: string | null,             // email format when present
  phone?: string | null,
  addressLine1?, addressLine2?,
  city?, state?, postalCode?, country?,
  placeId?, latitude?, longitude?,   // when filled from Places
  notes?: string | null,
  locationId?: string (UUID)
}
```

**Response 201:** full customer row.

**Errors:** `400 VALIDATION_ERROR`, `400 INVALID_TARGET`.

### `GET /api/v1/customers`

List. Query params: `search` (ILIKE on name/email/phone), `limit`
(default 50, max 200), `offset`. Rows are filtered to the caller's
scope via RLS + app-layer WHERE. Soft-deleted rows are hidden.

**Response:** `{ rows, total, limit, offset }`

### `GET /api/v1/customers/:id`

Returns the row or `404 NOT_FOUND` when not in scope.

### `PATCH /api/v1/customers/:id`

Partial update. Returns the updated row. `404` when not in scope.

### `DELETE /api/v1/customers/:id`

Soft-deletes (`deleted_at = now()`). Idempotent — second call returns
`{ deleted: false, alreadyDeleted: true }`.

---

## Jobs

### `POST /api/v1/jobs`

Creates a job bound to a customer. The customer must be in the
caller's scope (`400 INVALID_TARGET` otherwise). Initial `status` is
always `unassigned`.

**Body:** `customerId`, `title`, `description?`, `scheduledStart?`,
`scheduledEnd?`, `assignedTechUserId?`, `locationId?`.

### `GET /api/v1/jobs`

List with filters: `customerId`, `status`, `assignedTechUserId`, plus
`limit` / `offset`. Returns `{ rows, total, limit, offset }` ordered
by `created_at DESC`.

### `GET /api/v1/jobs/:id`

Returns the row or `404`.

### `PATCH /api/v1/jobs/:id`

Partial update of non-status fields only (`title`, `description`,
`scheduledStart`, `scheduledEnd`, `assignedTechUserId`, `locationId`).
Status changes go through `/transition`.

### `POST /api/v1/jobs/:id/transition`

Body: `{ toStatus, reason? }`.

Enforces the transition matrix (see
`apps/api/src/job-status-machine.ts`). Illegal moves return
`409 INVALID_TRANSITION`. Writes the update and a `job_status_log`
row in the same transaction so state and history can't diverge. Sets
`actual_start` on `arrived` and `actual_end` on `completed` /
`canceled`.

Transition matrix:

```
unassigned   → scheduled, canceled
scheduled    → en_route, unassigned, canceled
en_route     → arrived, canceled
arrived      → in_progress, canceled
in_progress  → completed, canceled
completed    → (terminal)
canceled     → (terminal)
```

---

## Job photos

### `POST /api/v1/jobs/:id/photos/upload-url`

Issues a short-lived presigned PUT URL. Body:

```ts
{
  contentType: string,   // MIME type
  label?: string | null,
  extension?: string     // 1-8 alphanumeric, default "jpg"
}
```

**Response 200:**

```ts
{
  uploadUrl: string,     // PUT target (15-minute TTL)
  storageKey: string,    // jobs/<jobId>/photos/<uuid>.<ext>
  expiresAt: string      // ISO-8601
}
```

### `POST /api/v1/jobs/:id/photos`

Finalise after the browser's PUT succeeds. Body:

```ts
{
  storageKey: string,    // must start with jobs/<jobId>/photos/
  contentType: string,
  sizeBytes: number,     // > 0, ≤ 50MB
  label?: string | null
}
```

Writes `job_photos` and returns the row plus a fresh download URL.

Rejects mismatched `storageKey` with `400 INVALID_TARGET` (prevents a
caller from claiming bytes in another job's namespace).

### `GET /api/v1/jobs/:id/photos`

Returns all photos for the job with fresh `downloadUrl`s on every
call (URLs are short-lived; never cache them client-side).

### `DELETE /api/v1/jobs/:id/photos/:photoId`

Removes the row only. Bucket object is left behind intentionally —
lifecycle/cleanup is a v2 concern (`docs/TECH_DEBT.md`).

---

## Google Places (address autocomplete)

### `GET /api/v1/places/autocomplete?q=<query>`

Returns up to three `{ placeId, description }` candidates. Queries
shorter than 2 characters short-circuit to an empty list.

### `GET /api/v1/places/:placeId`

Returns a `PlaceDetails` record (formatted address, split fields,
lat/lng) or `404 NOT_FOUND`.

Dev + tests use `stubPlacesClient` (deterministic three-result
fixture). Production wires `googlePlacesClient(GOOGLE_MAPS_API_KEY)`.

---

## Franchisees

### `GET /api/v1/franchisees`

Lists franchisees visible to the caller (platform: all; franchisor: their
franchisor; franchisee-scoped: their own). Used by the web HQ
"View as" picker and the new-customer form's location dropdown.

---

## Error codes

Phase-3-specific codes; tenancy codes carry over from
`docs/api/tenancy.md`.

| Code                  | Status | When                                          |
|-----------------------|--------|-----------------------------------------------|
| `VALIDATION_ERROR`    | 400    | Zod input validation failed                   |
| `INVALID_TARGET`      | 400    | Cross-tenant location/customer/storageKey     |
| `NOT_FOUND`           | 404    | Row doesn't exist OR is outside scope         |
| `INVALID_TRANSITION`  | 409    | State-machine rejected the move               |

Cross-tenant access always returns `404` rather than `403` so the
caller cannot infer the existence of a row they shouldn't see.
