# Pricebook API (phase_pricebook)

All endpoints return the canonical envelope. Anonymous callers get
`401 UNAUTHENTICATED`; catalog mutations additionally require
`platform_admin` or `franchisor_admin` scope (franchisee-scoped
callers get `403 CATALOG_READONLY`).

Source of truth: `apps/api/src/catalog-routes.ts` +
`apps/api/src/pricebook-routes.ts`.

---

## HQ catalog (franchisor_admin / platform_admin)

### `POST /api/v1/catalog/templates`

Create a draft template.

**Body:** `{ name, slug, notes?, franchisorId? }`. `franchisorId` is
required for platform admins; franchisor admins derive it from scope.

**Response 201:** template row with `status: 'draft'`.

### `GET /api/v1/catalog/templates`

List templates visible to the caller. Anyone with an active scope can
read (franchisees see their franchisor's templates via the
`scoped_read` RLS policy).

### `GET /api/v1/catalog/templates/:id`

Read one. `404` when out of scope.

### `PATCH /api/v1/catalog/templates/:id`

Partial update of `{ name, slug, notes }` — only while
`status === 'draft'`. Returns `409 TEMPLATE_NOT_EDITABLE` otherwise.

### `POST /api/v1/catalog/templates/:id/publish`

Atomically flips the template to `published`. Any previously
`published` template for the same franchisor is set to `archived` in
the same transaction so the "at most one published per franchisor"
invariant holds under concurrency. Rejects `archived` templates with
`409 TEMPLATE_ARCHIVED`.

### `POST /api/v1/catalog/templates/:id/archive`

Flips any non-archived template to `archived`.

### `POST /api/v1/catalog/templates/:id/items`

Create an item. Draft-only; `409 TEMPLATE_NOT_EDITABLE` otherwise.

**Body:**
```ts
{
  sku: string,              // ≤80, unique per template
  name: string,             // ≤200
  description?: string,
  category: string,         // ≤80
  unit: string,             // ≤40 (e.g. "each", "pair", "linear_foot")
  basePrice: number,        // ≥0
  floorPrice?: number,      // ≥0, ≤ ceilingPrice when both set
  ceilingPrice?: number,
  sortOrder?: number
}
```

### `GET /api/v1/catalog/templates/:id/items`

List items. Readable by any scoped user.

### `PATCH /api/v1/catalog/templates/:id/items/:itemId`

Partial update of item fields. Draft-only.

### `DELETE /api/v1/catalog/templates/:id/items/:itemId`

Soft-delete. Draft-only.

---

## Franchisee pricebook

### `GET /api/v1/pricebook`

Resolved view for the caller's franchisee. Platform + franchisor
admins can peek as a specific franchisee via `?franchiseeId=<uuid>`.

**Response 200:**
```ts
{
  ok: true,
  data: {
    franchiseeId: string,
    franchisorId: string,
    rows: Array<{
      serviceItemId: string,
      templateId: string,
      sku: string,
      name: string,
      description: string | null,
      category: string,
      unit: string,
      basePrice: string,       // numeric(12,2) serialized
      floorPrice: string | null,
      ceilingPrice: string | null,
      overrideId: string | null,
      overridePrice: string | null,
      effectivePrice: string,  // override else base
      overridden: boolean
    }>
  }
}
```

Rows come from the franchisor's single `published` template. If no
published template exists, `rows` is `[]`. Order: `sortOrder ASC`,
then `name ASC`.

### `POST /api/v1/pricebook/overrides`

Upsert a per-franchisee override. One active override per
`(franchiseeId, serviceItemId)` — a re-POST updates in place
(response `200`). A fresh create returns `201`.

**Body:** `{ serviceItemId, overridePrice, note? }`.

**Bounds:** enforced server-side.
- `overridePrice < floor_price` → `400 PRICE_OUT_OF_BOUNDS`
  (message contains the floor value)
- `overridePrice > ceiling_price` → `400 PRICE_OUT_OF_BOUNDS`
  (message contains the ceiling value)

**Other errors:**
- `400 INVALID_TARGET` — `serviceItemId` missing or belongs to a
  different franchisor
- `409 TEMPLATE_NOT_PUBLISHED` — item's template is draft/archived

### `DELETE /api/v1/pricebook/overrides/:id`

Soft-delete. Idempotent: `{ deleted: true }` on first call,
`{ alreadyDeleted: true }` on replay. `404` when out of scope.

---

## Error codes

Pricebook-specific; tenancy + customer/job codes carry through.

| Code                       | Status | When                                                         |
|----------------------------|--------|--------------------------------------------------------------|
| `CATALOG_READONLY`         | 403    | Non-admin tried to write a template or item                  |
| `TEMPLATE_NOT_EDITABLE`    | 409    | Update / add-item attempted on a published/archived template |
| `TEMPLATE_ARCHIVED`        | 409    | Publish attempted on an archived template                    |
| `TEMPLATE_NOT_PUBLISHED`   | 409    | Override attempted on an item in a draft/archived template   |
| `PRICE_OUT_OF_BOUNDS`      | 400    | Override below floor or above ceiling                        |
| `INVALID_TARGET`           | 400    | serviceItemId belongs to another franchisor, or locationId / franchiseeId are out-of-scope |

Cross-tenant access always returns `404 NOT_FOUND` rather than `403`
so the caller cannot infer the existence of a row they shouldn't see.
