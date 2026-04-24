# Royalty engine + statement endpoints — phase_royalty_engine

Extends payments with franchise-agreement-driven application fees
and monthly reconciliation. The hard-coded 5% fee from phase 7 is
now the fallback when no agreement is active.

Shared conventions:
- `{ ok: true, data }` / `{ ok: false, error }` envelopes.
- Cross-tenant access returns `404` (no existence leak).
- Illegal state transitions → `409`.

---

## Agreement CRUD (admin-only except GET)

### POST /api/v1/franchisees/:id/agreement

Creates a **draft** agreement with an optional rules array. Roles:
`platform_admin`, owning `franchisor_admin`. Others → `403 FORBIDDEN`.

**Body:**
```json
{
  "name": "Elevated 2026 Denver",
  "notes": "...",
  "startsOn": "2026-01-01T00:00:00Z",
  "rules": [
    { "type": "percentage", "params": { "basisPoints": 800 } },
    { "type": "minimum_floor", "params": { "perMonthCents": 50000 } }
  ]
}
```

Rule `params` shapes are validated per-type with Zod; malformed rules
return `400 VALIDATION_ERROR` and never reach the DB.

### GET /api/v1/franchisees/:id/agreement

Returns the active agreement + its rules. Falls back to the most
recent non-active agreement if none is active. Franchisee-scope
users can read their own; other roles use the admin path.

Response when no agreement exists: `{ data: null }`.

### PATCH /api/v1/franchisees/:id/agreement/:aid

Replaces the rules array (or renames) on a **draft**. Active
agreements → `409 AGREEMENT_LOCKED`. Admin-only.

### POST /api/v1/franchisees/:id/agreement/:aid/activate

Ends any prior active agreement and flips this one to `active`
atomically. Admin-only.

---

## Statements

### POST /api/v1/franchisees/:id/statements/generate

**Body:** `{ year: 2026, month: 1, timezone?: "America/Denver" }`

Admin-only. Runs `generateMonthlyStatement` — reads payments +
refunds in the tz-aware period, computes gross / refund / net /
owed / collected / variance, upserts the row.

### GET /api/v1/franchisees/:id/statements

Lists statements for a specific franchisee. Admin roles see their
franchisees' rows; the owning franchisee can see their own; other
franchisees → `404`.

### GET /api/v1/statements

Convenience list for the caller's scope:
- Platform admin: all statements.
- Franchisor admin: statements for franchisees in their franchisor.
- Franchisee-scope users: their own statements only.

### POST /api/v1/statements/:id/reconcile

Admin-only. Creates a Stripe Transfer for `abs(variance)`, stamps
`transfer_id`, flips status to `reconciled`. Replaying → `409
ALREADY_RECONCILED`. Franchisee without a connected account →
`409 STRIPE_NOT_READY`.

---

## Error codes (phase 8 additions)

| Code | HTTP | Meaning |
|---|---|---|
| `FORBIDDEN`          | 403 | Caller is not an admin of this franchisor. |
| `AGREEMENT_LOCKED`   | 409 | PATCH attempted on an active agreement. |
| `ALREADY_ACTIVE`     | 409 | Activate on an already-active agreement. |
| `INVALID_TRANSITION` | 409 | Activate on a non-draft agreement. |
| `ALREADY_RECONCILED` | 409 | Second reconcile on a statement. |
| `STRIPE_NOT_READY`   | 409 | Franchisee has no connected account for the transfer. |

---

## Rule reference

### `percentage`
```json
{ "type": "percentage", "params": { "basisPoints": 800 } }
```
`basisPoints` ∈ [0, 10000]. 800 = 8%.

### `flat_per_job`
```json
{ "type": "flat_per_job", "params": { "amountCents": 2500 } }
```
Adds a fixed amount per invoice. `amountCents` ≤ $1M.

### `tiered`
```json
{
  "type": "tiered",
  "params": {
    "tiers": [
      { "upToCents": 1000000, "basisPoints": 1000 },
      { "upToCents": 5000000, "basisPoints": 800 },
      { "upToCents": null,     "basisPoints": 500 }
    ]
  }
}
```
Tiers must be ascending on `upToCents`. At most one `null` tier,
and only at the end (absorbs overflow).

### `minimum_floor`
```json
{ "type": "minimum_floor", "params": { "perMonthCents": 50000 } }
```
Bumps the fee so `monthFeesAccruedCents + fee >= perMonthCents`.
Clamped to `totalCents` so fee never exceeds invoice total.
