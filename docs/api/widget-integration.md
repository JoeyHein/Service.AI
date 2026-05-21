# Door-Designer Widget Integration (WI) — phase 22

Turns the OPENDC door-designer widget (a finished standalone IIFE that lives
in `bc-ai-agent/widget`) into a Service.AI lead/quote source. A homeowner who
configures a door on a public site, or a manager designing one inside the
quote builder, lands a customer + draft quote in Service.AI.

This is a "harvest existing assets" phase — the widget stays built in
bc-ai-agent (served at `https://portal.opendc.ca/widget/opendc-door-designer.iife.js`);
we only repoint its `quoteWebhook` and embed the IIFE.

## v1 scope: lead capture, not auto-pricing

The widget emits a **human-readable `doorConfig`** (family, size, design, color,
windows…), not resolved BC SKUs — SKU resolution lives in BC AI Agent's
`part_number_service`. So v1 captures the config on a draft quote and a manager
prices it in the quote builder. Auto-resolution (config → BC part numbers →
priced lines) is a deferred follow-up (see TD-WI-01).

## Webhook payload (from the widget)

```jsonc
{
  "contact": { "name": "…", "email": "…", "phone": "…", "postalCode": "…", "notes": "…" },
  "doorConfig": { "family": "Panorama", "doorType": "residential", "size": "16' x 7'",
                  "widthInches": 192, "heightInches": 84, "design": "Flush",
                  "color": "Black", "windows": "Top row", "glassType": "…", "…": "…" },
  "doorImage": "data:image/png;base64,…",
  "source": "dealer_locator",   // optional
  "timestamp": "2026-05-20T…Z"
}
```

`contact.name` is required; everything else is optional. Unknown top-level keys
are rejected (`.strict()`); unknown `contact` / `doorConfig` keys are tolerated
(the widget's config shape evolves independently).

## Two intake paths

### 1. Public lead intake (cross-origin, no auth)

```
POST /api/v1/public/widget/quote-request      apps/api/src/public-widget-routes.ts
```

- Registered **outside RequestScope** — it's an inbound lead; the only "auth"
  is that it can only ever *create* a draft lead. CORS is open (the API's
  default `@fastify/cors`), so elevateddoors.com can POST to it.
- Resolves the **intake branch** (`LEAD_INTAKE_BRANCH_SLUG`, else the first
  branch by `created_at`) and the **default supplier** (first `suppliers` row).
  503 `NOT_CONFIGURED` if neither exists yet.
- **Find-or-create customer** by `email` within the intake branch; no email →
  a fresh anonymous lead customer. Customer-originated, so `created_by_user_id`
  is NULL (same rule as the customer-accept path).
- Creates a **draft quote** (`status='draft'`, `supplier_id` set) capturing the
  config in `quotes.notes` (`Door designer lead — <summary>` + the full JSON).
- Best-effort stores `doorImage` to the object store under
  `widget-leads/<quoteId>.png` and stamps `Image: <key>` on the notes. Image
  failures never block intake.
- Returns `201 { ok, data: { quoteId, customerId } }`.

#### Site embed snippet

A single self-mounting loader, served by the web app at `/embed/door-designer.js`:

```html
<div id="serviceai-door-designer"></div>
<script
  src="https://app.serviceai.example/embed/door-designer.js"
  data-api="https://api.serviceai.example"></script>
```

The loader fetches the door-designer IIFE and calls
`OpenDCDesigner.init({ container, quoteWebhook })` with the webhook pointed at
the public intake. `data-api` overrides the API origin (defaults to the origin
the loader was served from); `data-container` overrides the mount selector;
`data-designer` overrides the IIFE URL.

### 2. In-app embed (authenticated, on the current quote)

The quote builder (`/quotes/new`) shows a **"Design a door"** button once a
draft quote exists. It opens `DesignDoorModal`, which loads the same IIFE and
points its `quoteWebhook` at:

```
POST /api/v1/quotes/:id/design-config         apps/api/src/quote-routes.ts
```

Because this path is same-origin (`/api/*` is a Next.js rewrite) and the
widget's `fetch` uses the default `same-origin` credentials mode, the session
cookie flows automatically — no token plumbing needed. The endpoint is
branch-scoped (`req.requireScope()` + app-layer WHERE + `withScope`), validates
the quote id, and appends `Designed door — <summary>` + the config JSON to the
quote's notes. Cross-branch quote → 404.

> In-app image storage is intentionally deferred — the manager just saw the
> design on screen, so v1 keeps the in-app path notes-only. The public lead
> path stores the image because nobody on the Service.AI side saw it.

## Files

| Path | Role |
|---|---|
| `apps/api/src/public-widget-routes.ts` | public lead intake (WI-01) |
| `apps/api/src/quote-routes.ts` (`/design-config`) | in-app config attach (WI-02) |
| `apps/api/src/object-store.ts` (`storeDoorImage`, `putObject`) | server-side image upload |
| `apps/web/src/app/(app)/quotes/new/DesignDoorModal.tsx` | in-app modal |
| `apps/web/public/embed/door-designer.js` | site embed loader |

## Deferred (TD-WI-01)

Auto-SKU resolution: a new BC AI Agent external endpoint that maps a
`doorConfig` to BC part numbers + quantities (wrapping `part_number_service`),
so the widget lead arrives as priced lines instead of a notes block. Until
then, a manager prices each lead by hand.
