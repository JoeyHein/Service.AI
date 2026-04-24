# Franchisor console endpoints — phase_franchisor_console

Phase 13 exposes two new endpoints (network metrics + onboard)
and adds three filter params to the phase-2 audit log search.
Admin-only: `platform_admin` (cross-tenant) and
`franchisor_admin` (scoped to own franchisees). Franchisee_owner,
dispatcher, tech, and CSR → 403.

---

## GET /api/v1/franchisor/network-metrics

Aggregated revenue / AR / AI spend / royalty / job counts across
the caller's scope, over a rolling period (default: trailing
30 days UTC).

**Query params:**

| Name | Type | Default | Notes |
|---|---|---|---|
| `periodStart` | ISO-8601 | now - 30 days | Malformed → 400 |
| `periodEnd` | ISO-8601 | now | Malformed → 400 |

**200 response:**
```json
{
  "ok": true,
  "data": {
    "periodStart": "2026-03-24T...Z",
    "periodEnd": "2026-04-23T...Z",
    "totals": {
      "revenueCents": 1234567,
      "openArCents": 87500,
      "aiCostUsd": 12.34,
      "royaltyCollectedCents": 61728,
      "jobsCount": 42,
      "franchiseeCount": 3
    },
    "perFranchisee": [
      {
        "franchiseeId": "uuid",
        "name": "Denver Metro",
        "slug": "denver",
        "revenueCents": 500000,
        "openArCents": 32000,
        "aiCostUsd": 5.20,
        "royaltyCollectedCents": 25000,
        "jobsCount": 16
      }
    ]
  }
}
```

Scope rules:

- `platform_admin` → every franchisee across every franchisor.
- `franchisor_admin` → every franchisee whose
  `franchisor_id = scope.franchisorId`.
- All other scopes → 403.

---

## POST /api/v1/franchisor/onboard

Creates a franchisee row under the caller's franchisor.

**Body:**
```json
{
  "name": "Denver Metro Doors",
  "slug": "denver",
  "legalEntityName": "Denver Metro Doors, LLC",
  "locationName": "Denver HQ",
  "timezone": "America/Denver"
}
```

Only `name` + `slug` are required. `slug` must match
`/^[a-z0-9-]+$/`.

**201 response:**
```json
{
  "ok": true,
  "data": {
    "franchiseeId": "uuid",
    "franchisorId": "uuid",
    "slug": "denver"
  }
}
```

**Errors:**

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Missing / malformed slug or name |
| `UNAUTHORIZED` | 401 | No session |
| `FORBIDDEN` | 403 | Scope is not admin |
| `SLUG_TAKEN` | 409 | Slug already exists inside the caller's franchisor |

**Security notes:**

- Client-supplied `franchisorId` in the body is silently
  ignored for `franchisor_admin` callers — the server resolves
  the franchisor from `request.scope`. `platform_admin` must
  supply `franchisorId`, since they are cross-tenant.
- Slug uniqueness is scoped per franchisor; two different
  franchisors may both have a `denver` franchisee.

Downstream steps (Twilio provision, Stripe Connect onboarding,
pricebook publish, staff invite) use endpoints shipped in
phases 7 / 9 / 4 / 2 respectively. The wizard at
`/franchisor/onboard` chains them.

---

## GET /api/v1/audit-log (phase_franchisor_console filters)

Phase 2 already ships pagination + scope-visibility. Phase 13
adds three query params for the franchisor-console UI.

| Name | Type | Behaviour |
|---|---|---|
| `q` | string | Case-insensitive `ILIKE %q%` on `action` column. Bind-parameter only — never concatenated into SQL. |
| `userId` | string | Exact match on `actor_user_id`. |
| `kind` | enum | One of `impersonation`, `invoice`, `payment`, `agreement`, `onboard`, `catalog`. Anything else → 400. |

All existing pagination (`page`, `limit`), filter (`action`,
`fromDate`, `toDate`, `franchiseeId`, `actorEmail`), and
scope-visibility rules (franchisor admins see only their
franchisees' events, etc.) are unchanged.
