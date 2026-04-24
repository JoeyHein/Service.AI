# AI dispatcher endpoints — phase_ai_dispatcher

Five endpoints land this phase. All require a scoped session;
dispatch-role (franchisee_owner, location_manager, dispatcher)
or admin (platform, franchisor) only — tech + CSR → 403.

---

## POST /api/v1/dispatch/suggest

Triggers `runDispatcher` for the caller's franchisee. Platform
and franchisor callers must be impersonating a franchisee or the
endpoint returns `400 VALIDATION_ERROR`.

**201:**
```json
{
  "ok": true,
  "data": {
    "conversationId": "uuid",
    "proposals": 7,
    "autoApplied": 4,
    "queued": 3,
    "suggestions": [
      {
        "id": "uuid",
        "status": "applied",
        "confidence": 0.92,
        "jobId": "uuid",
        "techUserId": "user_...",
        "rejectedInvariant": null
      }
    ]
  }
}
```

---

## GET /api/v1/dispatch/suggestions

Query: `?status=pending|approved|rejected|applied|expired`.
Scopes: platform sees all, franchisor sees their franchisees',
franchisee-scope sees own.

---

## POST /api/v1/dispatch/suggestions/:id/approve

Re-verifies the suggestion's tenancy. Applies the proposed
assignment — updates the job row + flips suggestion to
`applied`. If the underlying job is already assigned or the
suggestion is no longer `pending`:

- `409 SUGGESTION_NOT_PENDING` — not in pending state.
- `409 STALE_SUGGESTION` — job has already been assigned.

---

## POST /api/v1/dispatch/suggestions/:id/reject

Flips status to `rejected` with `decided_at` + `decided_by_user_id`.

---

## GET /api/v1/dispatch/metrics?date=YYYY-MM-DD

Returns the day's rollup for the caller's franchisee:

```json
{
  "ok": true,
  "data": {
    "id": "uuid",
    "suggestionsTotal": 10,
    "autoApplied": 7,
    "queued": 3,
    "approved": 2,
    "rejected": 1,
    "overrideRate": "0.1000"
  }
}
```

---

## Error codes (phase 10 additions)

| Code | HTTP | Meaning |
|---|---|---|
| `FORBIDDEN`                | 403 | Tech or CSR called a dispatch endpoint. |
| `SUGGESTION_NOT_PENDING`   | 409 | Suggestion already decided. |
| `STALE_SUGGESTION`         | 409 | Underlying job already assigned. |
| `INVALID_TARGET`           | 400 | Tool argument references a cross-tenant row. |

---

## Scheduling invariants (auto-apply gate)

Before auto-applying, the runner verifies:

- Tech is not double-booked in the proposed window.
- If the agent's reasoning includes `requires: <skill>`, the
  tech carries that `tech_skills` row.
- Travel time from the tech's prior-job customer to the
  proposed customer + a 15-minute buffer fits in the gap
  before the proposed start.

A suggestion that fails any invariant drops to `pending` with
`rejectedInvariant` set (`double_booked`, `missing_skill:<s>`,
`travel_budget_exceeded`).
