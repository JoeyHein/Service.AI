# Tech mobile + invoice + push endpoints — phase_tech_mobile_pwa

Adds the first draft-invoice surface plus web-push subscription
management. Invoice finalise / send / pay transitions are out of
scope for this phase (they live in phase_invoice_payment) — status
stays `draft` throughout.

All endpoints follow the shared API conventions:
- `{ ok: true, data }` on success, `{ ok: false, error: { code,
  message } }` on failure.
- Cross-tenant access returns `404 NOT_FOUND` (no existence leak).
- Unauthenticated requests return `401 UNAUTHENTICATED`.

---

## POST /api/v1/jobs/:id/invoices

Create a draft invoice linked to `:id`. The server reads
`franchiseeId` and `customerId` off the job — they are not taken
from the request body.

**Body (all optional):**
```json
{
  "lines": [
    { "serviceItemId": "uuid", "quantity": 1, "unitPrice": 1800 }
  ],
  "taxRate": 0.08,
  "notes": "optional"
}
```

Each line:
- `serviceItemId` must reference a published service item.
- `quantity` > 0.
- `unitPrice` optional; defaults to the item's `base_price`.
  Must satisfy `floor_price ≤ unitPrice ≤ ceiling_price` when
  bounds are set, otherwise `400 PRICE_OUT_OF_BOUNDS`.
- Referenced item must live in a `published` template, otherwise
  `409 TEMPLATE_NOT_PUBLISHED`.

**201 response:**
```json
{
  "ok": true,
  "data": {
    "id": "uuid",
    "status": "draft",
    "subtotal": "1800.00",
    "taxRate": "0.08",
    "taxAmount": "144.00",
    "total": "1944.00",
    "lines": [ ... ]
  }
}
```

Totals are re-derived server-side on every create/patch; the
browser never submits them.

---

## GET /api/v1/invoices/:id

Returns the invoice plus its line items ordered by `sort_order`.

- Cross-tenant → `404 NOT_FOUND`.

---

## PATCH /api/v1/invoices/:id

Replaces the line set and/or updates `notes` + `taxRate`.
Draft-only; non-draft returns `409 INVOICE_NOT_EDITABLE`.

**Body (all optional; omitted fields are preserved):**
```json
{
  "lines": [ ... ],
  "notes": "string | null",
  "taxRate": 0.08
}
```

Totals are re-derived on every write — either from the replaced
line set, or (when only `taxRate` changes) from the existing
stored lines.

---

## DELETE /api/v1/invoices/:id

Soft-deletes a draft invoice. Non-draft → `409
INVOICE_NOT_EDITABLE`. Idempotent on replay:

- First call: `{ data: { deleted: true, alreadyDeleted: false } }`
- Subsequent: `{ data: { deleted: false, alreadyDeleted: true } }`

---

## POST /api/v1/push/subscribe

Register a Web Push subscription for the authenticated user.

**Body:**
```json
{
  "endpoint": "https://fcm.googleapis.com/wp/...",
  "keys": { "p256dh": "...", "auth": "..." },
  "userAgent": "optional string"
}
```

- A duplicate `(userId, endpoint)` is an upsert — the existing row
  is updated in place, returning the same `id`.
- An existing subscription owned by a different user is
  soft-deleted and a fresh row is created (the browser legitimately
  moved profiles).

**201 response:**
```json
{ "ok": true, "data": { "id": "uuid", ... } }
```

---

## DELETE /api/v1/push/subscriptions/:id

Revoke by id. Cross-user revoke → `404 NOT_FOUND`.

---

## DELETE /api/v1/push/subscribe

Revoke by endpoint (useful when a browser discards its own
subscription and wants the server to forget it).

**Body:**
```json
{ "endpoint": "https://fcm.googleapis.com/wp/..." }
```

Cross-user → `404 NOT_FOUND`.

---

## Error codes reference

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHENTICATED`         | 401 | No session cookie. |
| `VALIDATION_ERROR`        | 400 | Zod parse / bad UUID / bad URL. |
| `INVALID_TARGET`          | 400 | `serviceItemId` does not exist or not visible. |
| `PRICE_OUT_OF_BOUNDS`     | 400 | Line `unitPrice` outside item's floor/ceiling. |
| `NOT_FOUND`               | 404 | Invoice / subscription not found, including cross-tenant reads. |
| `TEMPLATE_NOT_PUBLISHED`  | 409 | Line references an item whose template isn't published. |
| `INVOICE_NOT_EDITABLE`    | 409 | PATCH/DELETE on a non-draft invoice. |
