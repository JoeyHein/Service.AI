# Phase Gate: phase_widget_integration

**STATUS: SHIPPED 2026-05-20. WI-01..03 landed. Ref: `docs/api/widget-integration.md`. Local-only.**

Phase 22 — second "harvest existing assets" phase. The OPENDC door-designer
widget (`bc-ai-agent/widget`) is a finished standalone IIFE
(`window.OpenDCDesigner.init({ container, quoteWebhook, dealerLocatorUrl })`).
On completion it POSTs `{ contact, doorConfig, doorImage, source?, timestamp }`
to `quoteWebhook`. Today that webhook points at BC AI Agent. This phase points
it at **Service.AI** so a configured door from elevateddoors.com becomes a
customer + draft quote (lead) that the branch can action — and embeds the
configurator inside the Service.AI quote builder.

## Webhook payload (from the widget)
```
{ contact: { name, email, phone, postalCode?, notes? },
  doorConfig: { family, doorType, doorSeries, size, widthInches, heightInches,
                design, color, windows, windowId, glassType, ... },
  doorImage: "<base64 png>", source?: "dealer_locator", timestamp }
```

## Must Pass

- [x] **WI-01** — `POST /api/v1/public/widget/quote-request` (public, no auth —
  it's an inbound lead). Validates the payload (Zod, `.strict()` on the top
  level; `doorConfig` accepted as an open object). Resolves the intake branch +
  default supplier, finds-or-creates the customer (by email within the branch),
  and creates a **draft** quote capturing `doorConfig` (in `quotes.notes` +
  metadata) for follow-up pricing. Idempotent-ish: a repeat within a short
  window for the same email+config is de-duped to one open lead (or just
  creates a new draft — see decisions). Returns `{ ok, data: { quoteId } }`.
  Rate-limited (public). Tests: payload validation, customer create/find,
  draft-quote creation, missing-contact 400.
- [x] **WI-02** — embedding:
  - In-app: a "Design a door" affordance in the quote builder that opens the
    widget (loaded from the portal IIFE URL) in a modal/section; on completion
    the config lands on the current quote (v1: as a note/line stub — full
    auto-SKU pricing is a follow-up).
  - Public/site: an embed snippet doc + a Service.AI-hosted loader that points
    `quoteWebhook` at `/api/v1/public/widget/quote-request`, for elevateddoors.com.
- [x] **WI-03** — docs (`docs/api/widget-integration.md`) + the door image to
  object storage (reuse the DO Spaces store) + TD for the deferred auto-SKU
  resolution (config → BC part numbers → priced lines).

## Resolved decisions (2026-05-20)
1. **v1 = lead capture, not auto-priced.** The widget gives a human-readable
   `doorConfig`, not resolved BC SKUs (SKU resolution lives in BC AI Agent's
   `part_number_service`). v1 creates a customer + draft quote with the config
   captured; a manager prices it in the quote builder. Auto-resolution
   (config → SKUs → priced lines via a new BC AI Agent endpoint) is a TD follow-up.
2. **Branch routing.** Single-branch pilot → route leads to the corporate's
   pilot branch (the first/only branch, or `LEAD_INTAKE_BRANCH_SLUG` if set).
   Postal-code → branch routing lands when multi-branch is real.
3. **Supplier.** Use the corporate's default supplier (the Elevated Doors BC
   supplier row) for the draft quote's `supplier_id`.
4. **Customer dedupe.** Find-or-create by `email` within the intake branch;
   no email → create an anonymous lead customer from name/phone.
5. **Door image.** Store via the existing object store (DO Spaces); keep the URL
   on the quote/customer for the manager to see what was configured.

## Out of scope
- Auto-SKU resolution + auto-pricing (TD follow-up — needs a BC AI Agent
  config→parts external endpoint).
- Multi-branch postal routing.
- Hosting/rebuilding the widget itself (it stays built in bc-ai-agent; we embed
  the IIFE + repoint its webhook).

## Tasks: WI-01 (webhook) → WI-02 (embed) → WI-03 (docs).

## Gate Decision
**APPROVED** (2026-05-20, Joey). Local-only.
