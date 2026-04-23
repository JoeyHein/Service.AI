# Dispatch API (phase_dispatch_board)

All endpoints return the canonical envelope. Anonymous callers get
`401 UNAUTHENTICATED`. Every endpoint goes through the defence-in-
depth combo established by earlier phases — `requireScope` +
`withScope` + explicit app-layer WHERE.

Source of truth:
- `apps/api/src/assignment-routes.ts`
- `apps/api/src/sse-routes.ts`
- `apps/api/src/techs-routes.ts`

---

## Assignment

### `POST /api/v1/jobs/:id/assign`

Assigns a tech to a job. If the job is currently `unassigned` the
handler atomically transitions it to `scheduled` and writes a
`job_status_log` row in the same transaction.

**Body:**
```ts
{
  assignedTechUserId: string,        // must be active 'tech' membership
                                     //   in the job's franchisee
  scheduledStart?: string | null,    // ISO-8601
  scheduledEnd?: string | null       // ISO-8601
}
```

**Response 200:** full job row (with updated `assignedTechUserId`
and, when auto-transitioned, `status: 'scheduled'`).

**Errors:**
- `400 VALIDATION_ERROR` — body schema / UUID path
- `400 INVALID_TARGET` — `assignedTechUserId` is not a tech in the job's franchisee (cross-franchisee OR wrong role OR doesn't exist)
- `404 NOT_FOUND` — job out of scope

### `POST /api/v1/jobs/:id/unassign`

Clears `assignedTechUserId`. If the job was `scheduled` with no
`scheduledStart`/`scheduledEnd` set, the handler also reverts the
status to `unassigned` (with a log row).

**Response 200:** updated job row.

---

## Live updates (SSE)

### `GET /api/v1/jobs/events/stream`

Returns `text/event-stream`. One SSE frame per event matching the
caller's scope. Events:

| Event type          | When                                              |
|---------------------|---------------------------------------------------|
| `job.assigned`      | `/assign` succeeded                               |
| `job.unassigned`    | `/unassign` succeeded                             |
| `job.transitioned`  | A status change (including auto-transitions from /assign + /unassign + the regular `/transition` endpoint) |

**Payload (every event):**
```ts
{
  type: 'job.assigned' | 'job.unassigned' | 'job.transitioned',
  franchiseeId: string,
  franchisorId: string,
  jobId: string,
  assignedTechUserId?: string | null,
  fromStatus?: string | null,
  toStatus?: string | null,
  actorUserId?: string | null,
  at: string                         // ISO-8601
}
```

**Payloads carry IDs only.** Clients re-fetch `/api/v1/jobs/:id` for
details — that endpoint is already scope-filtered, so a client that
shouldn't see a job never sees its contents via the event stream.

**Scope filtering:**
- Franchisee → events whose `franchiseeId === scope.franchiseeId`
- Franchisor admin → events in any of their franchisees (resolved at connect)
- Platform admin → everything

**Heartbeat:** a comment frame (`: keepalive\n\n`) every 15 s so
proxies keep idle sockets open.

**Latency budget:** gate requires p95 < 500 ms across 10 concurrent
subscribers — verified by `live-sse-latency.test.ts`.

---

## Tech list

### `GET /api/v1/techs`

Lists active `tech` memberships visible to the caller.

**Query:** `?franchiseeId=<uuid>` — required for platform + franchisor admins.

**Response 200:**
```ts
{
  ok: true,
  data: Array<{
    userId: string,
    name: string | null,
    email: string
  }>
}
```

**Errors:**
- `400 VALIDATION_ERROR` — platform / franchisor admin missing `franchiseeId`
- `404 NOT_FOUND` — franchisee doesn't exist OR is out of scope

---

## Error codes

Phase 5 doesn't introduce new codes beyond the ones earlier phases
defined (`UNAUTHENTICATED`, `VALIDATION_ERROR`, `INVALID_TARGET`,
`NOT_FOUND`). Cross-tenant access returns `404 NOT_FOUND` rather
than `403` so the caller cannot infer row existence.
