# Tenancy API (phase_tenancy_franchise)

All endpoints return the canonical envelope:

```ts
{ ok: true, data: T } | { ok: false, error: { code: string, message: string } }
```

Unless otherwise noted, endpoints require a valid Better Auth session
cookie (`HttpOnly`, `SameSite=Lax`). Anonymous callers get `401
UNAUTHENTICATED`. Callers authenticated but without an active
`memberships` row get `403 NO_ACTIVE_MEMBERSHIP` when they hit a
scope-requiring endpoint.

Source of truth for shapes: `apps/api/src/*.ts`. Testing: every listed
endpoint has at least one live-Postgres test under
`apps/api/src/__tests__/live-*.test.ts`.

---

## Authentication (Better Auth)

Mounted at `/api/auth/*`. Better Auth owns this namespace — its full
set of routes (sign-up/email, sign-in/email, sign-in/magic-link,
sign-out, session) is available. See
[better-auth.com/docs](https://better-auth.com/docs).

Service.AI configuration (`apps/api/src/app.ts` + `packages/auth`):
- `emailAndPassword.enabled: true`
- Magic-link plugin wired but email delivery is stubbed to stdout in
  dev (`packages/auth/src/sender.ts#loggingSender`)
- Session cookie: `httpOnly`, `sameSite=lax`, `secure` in production,
  7-day expiry, auto-rotated at 24h

Key endpoints used by the web UI:
- `POST /api/auth/sign-up/email` — body `{ email, password, name }`
- `POST /api/auth/sign-in/email` — body `{ email, password }`
- `POST /api/auth/sign-out`
- `GET /api/auth/session` — Better Auth's own session probe

---

## `GET /api/v1/me`

Returns the authenticated user's resolved scope + any active
impersonation context. Never errors on missing auth — returns 401
with the canonical envelope instead.

**Auth:** required.

**Response 200:**
```jsonc
{
  "ok": true,
  "data": {
    "user": { "id": "..." },
    "scope": {
      "type": "franchisee",        // "platform" | "franchisor" | "franchisee"
      "userId": "...",
      "role": "dispatcher",
      "franchisorId": "...",       // present on franchisor/franchisee
      "franchiseeId": "...",       // present on franchisee
      "locationId": null
    } | null,                      // null when authenticated but unscoped
    "impersonating": {
      "targetFranchiseeId": "...",
      "targetFranchiseeName": "Denver Metro"  // null if lookup unavailable
    } | null
  }
}
```

**Response 401** — `{ ok: false, error: { code: "UNAUTHENTICATED" } }`

---

## Invitations

All invite endpoints live under `/api/v1/invites`. Creation and
listing require an active scope. Redemption endpoints are public for
the metadata GET (by token) but require a session for POST.

### `POST /api/v1/invites` — create invite

**Auth:** required + scoped. The caller's scope must match the
`canInvite(inviterScope, target)` matrix (`apps/api/src/can-invite.ts`):

| Inviter | May invite |
|---|---|
| `platform_admin` | any role anywhere |
| `franchisor_admin` | any invitable role within their franchisor |
| `franchisee_owner` | `location_manager` / `dispatcher` / `tech` / `csr` within own franchisee |
| `location_manager` | `dispatcher` / `tech` / `csr` within own franchisee |
| `dispatcher` / `tech` / `csr` | nothing |

**Body:**
```ts
{
  email: string,                              // required; lowercased server-side
  role: 'franchisor_admin' | 'franchisee_owner'
      | 'location_manager' | 'dispatcher' | 'tech' | 'csr',
  scopeType: 'franchisor' | 'franchisee' | 'location',
  franchiseeId?: string,                      // UUID, required for franchisee/location
  locationId?: string                          // UUID, optional
}
```

**Response 201:**
```jsonc
{
  "ok": true,
  "data": {
    "id": "...",
    "expiresAt": "ISO-8601",                  // 72h from creation
    "acceptUrl": "<acceptUrlBase>/accept-invite/<token>"
  }
}
```

**Errors:**
- `400 VALIDATION_ERROR` — malformed body
- `400 INVALID_TARGET` — missing `franchiseeId` when scope is franchisee/location, or target franchisee doesn't exist
- `401 UNAUTHENTICATED`
- `403 NO_ACTIVE_MEMBERSHIP`
- `403 ROLE_NOT_INVITABLE` — matrix reject

On success the invite email is sent through the configured
`MagicLinkSender` (dev stub writes to stdout; production wires a real
provider). Only the SHA-256 hash of the token is stored.

### `GET /api/v1/invites` — list pending invites

**Auth:** required + scoped. Returns invites the caller can see per
their scope (RLS + app-layer WHERE).

**Response 200:**
```jsonc
{
  "ok": true,
  "data": [
    {
      "id": "...",
      "email": "...",
      "role": "...",
      "scopeType": "franchisor" | "franchisee" | "location",
      "franchiseeId": "..." | null,
      "expiresAt": "ISO-8601",
      "createdAt": "ISO-8601"
    }
  ]
}
```

Only invites that are **not redeemed**, **not revoked**, and **not
expired** appear.

### `DELETE /api/v1/invites/:id` — revoke (idempotent)

**Auth:** required + scoped.

**Response 200:**
```jsonc
{ "ok": true, "data": { "revoked": true,  "alreadyRevoked": false } }
// or (idempotent replay):
{ "ok": true, "data": { "revoked": false, "alreadyRevoked": true  } }
```

**Errors:**
- `400 VALIDATION_ERROR` — id is not a UUID
- `404 NOT_FOUND` — invite doesn't exist OR belongs to a tenant outside the caller's scope (no leak)

### `GET /api/v1/invites/accept/:token` — public metadata

**Auth:** none. Rate-limited via the global Fastify rate limiter.
Looks up by SHA-256 hash of the token.

**Response 200:**
```jsonc
{
  "ok": true,
  "data": {
    "email": "...",                           // lowercase
    "role": "...",
    "scopeType": "...",
    "expiresAt": "ISO-8601"
  }
}
```

**Errors:**
- `404 NOT_FOUND`
- `410 INVITE_EXPIRED` / `INVITE_REVOKED` / `INVITE_USED`

### `POST /api/v1/invites/accept/:token` — redeem

**Auth:** required. The authenticated user's email **must match** the
invite's email; otherwise `403 EMAIL_MISMATCH`.

**Response 200:**
```jsonc
{
  "ok": true,
  "data": {
    "membershipId": "...",
    "role": "...",
    "scopeType": "...",
    "franchiseeId": "..." | null
  }
}
```

Creates exactly one `memberships` row, sets `redeemed_at` + `redeemed_user_id`
on the invite atomically (single transaction).

**Errors:**
- `401 UNAUTHENTICATED` — no session, or session maps to no user
- `403 EMAIL_MISMATCH`
- `404 NOT_FOUND`
- `410 INVITE_EXPIRED` / `INVITE_REVOKED` / `INVITE_USED`

---

## `GET /api/v1/franchisees`

Lists franchisees visible to the caller.

**Auth:** required + scoped.

**Visibility per scope:**
- `platform` — all franchisees
- `franchisor` — franchisees whose `franchisor_id` equals the caller's
- `franchisee` — only the caller's own row

**Response 200:**
```jsonc
{
  "ok": true,
  "data": [
    {
      "id": "...",
      "name": "...",
      "slug": "...",
      "franchisorId": "..."
    }
  ]
}
```

Used by the web UI's `/franchisor/franchisees` page to render the
"View as" picker for impersonation.

---

## `GET /api/v1/audit-log`

Paginated view of `audit_log` rows.

**Auth:** required. `platform_admin` and `franchisor_admin` only —
every other scope gets `403 AUDIT_FORBIDDEN`.

**Query params (all optional):**
- `actorEmail` — case-insensitive substring on `users.email` (joined)
- `franchiseeId` — exact match on `target_franchisee_id`
- `action` — case-insensitive substring
- `fromDate` / `toDate` — ISO-8601, inclusive
- `limit` — default 50, max 200
- `offset` — default 0

**Response 200:**
```jsonc
{
  "ok": true,
  "data": {
    "rows": [
      {
        "id": "...",
        "actorUserId": "..." | null,
        "actorEmail": "..." | null,
        "targetFranchiseeId": "..." | null,
        "action": "impersonate.request",
        "scopeType": "franchisee" | "franchisor" | "location" | "platform" | null,
        "scopeId": "..." | null,
        "metadata": { /* JSONB payload */ },
        "ipAddress": "..." | null,
        "userAgent": "..." | null,
        "createdAt": "ISO-8601"
      }
    ],
    "total": 1234,
    "limit": 50,
    "offset": 0
  }
}
```

Franchisor admins see only rows whose `target_franchisee_id` is under
their franchisor, plus rows scoped directly to their franchisor.
Platform admins see everything. Rows are ordered by `created_at DESC`.

**Errors:**
- `401 UNAUTHENTICATED`
- `403 AUDIT_FORBIDDEN`

---

## Impersonation inputs

The `requestScopePlugin` (`apps/api/src/request-scope.ts`) accepts the
impersonation target from either source, header-wins:

1. Header: `X-Impersonate-Franchisee: <uuid>`
2. Cookie: `serviceai.impersonate=<uuid>` (set by the web UI's
   `/impersonate/start` route handler)

On validation failure the request is rejected before the route runs:

- `403 IMPERSONATION_FORBIDDEN` — caller is not `franchisor_admin`, or
  the target franchisee belongs to a different franchisor
- `403 IMPERSONATION_INVALID_TARGET` — malformed UUID, or target
  franchisee doesn't exist
- `403 IMPERSONATION_DISABLED` — server configured without a
  `FranchiseeLookup` (test environments; production always wires it)

On success a single `audit_log` row is written
(`action='impersonate.request'`) with the actor, target, and request
metadata (method, url, ip, user-agent).
