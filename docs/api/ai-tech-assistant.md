# AI tech assistant endpoints — phase_ai_tech_assistant

Three endpoints. Tech / dispatcher / franchisee_owner /
location_manager only; CSR → 403. Admins must be impersonating
a franchisee.

---

## POST /api/v1/jobs/:id/photo-quote

**Body:**
```json
{
  "imageRef": "storage-key-from-upload-url-flow",
  "description": "customer says it snapped"
}
```

**200 response:**
```json
{
  "ok": true,
  "data": {
    "conversationId": "uuid",
    "vision": {
      "make": "Clopay",
      "model": "Classic Steel",
      "failureMode": "broken torsion spring",
      "tags": ["broken-spring", "torsion", "clopay"],
      "rawText": "...",
      "confidence": 0.92
    },
    "candidates": [
      {
        "serviceItemId": "uuid",
        "sku": "SPR-TORSION-PAIR",
        "name": "Torsion spring pair",
        "unitPriceDollars": "380.00",
        "confidence": 0.97,
        "reasoning": "...",
        "requiresConfirmation": false,
        "supportingSources": ["fail-broken-torsion"]
      }
    ]
  }
}
```

---

## POST /api/v1/jobs/:id/notes-to-invoice

**Body:** `{ "notes": "replaced 2 torsion springs; lubed rollers" }`

**200 response:**
```json
{
  "ok": true,
  "data": {
    "conversationId": "uuid",
    "description": "Replaced the torsion spring pair and lubricated rollers.",
    "intent": "repair",
    "warnings": []
  }
}
```

The model is instructed to return JSON. Non-JSON output falls
back to `description = raw text`, warnings empty.

---

## POST /api/v1/ai/feedback

**Body:**
```json
{
  "conversationId": "uuid|optional",
  "kind": "accept" | "override",
  "subjectKind": "photo_quote_item" | "notes_invoice_draft" | "dispatcher_assignment",
  "subjectRef": { ... }
}
```

`subjectRef` is a free-form jsonb; convention by subjectKind:
- `photo_quote_item` → `{ serviceItemId, sku, confidence }`.
- `notes_invoice_draft` → `{ description: <first 120 chars> }`.
- `dispatcher_assignment` → `{ suggestionId }`.

**201 response:** the inserted `ai_feedback` row.

---

## Error codes (phase 11 additions)

| Code | HTTP | Meaning |
|---|---|---|
| `FORBIDDEN`          | 403 | CSR (or other non-assistant role) attempted access. |
| `NOT_FOUND`          | 404 | Cross-tenant job id. |
| `VALIDATION_ERROR`   | 400 | Missing imageRef, empty/oversized notes, bad feedback kind. |

---

## Guardrails

Each franchisee carries `ai_guardrails.techPhotoQuoteCapCents`
(default 50000 = $500). Any candidate whose
`unitPriceDollars * 100` exceeds the cap is returned with
`requiresConfirmation: true`; the API never auto-adds flagged
items to an invoice.

## Kb_docs

Seed ships ~40 garage-door articles covering brand profiles,
failure diagnostics, part cross-references, safety notes, and
decision trees. Embeddings are stored as jsonb float arrays +
scored in JS (pgvector deferred). Articles include `sku:`-
prefixed tags so the photoQuote pipeline can resolve directly
to pricebook items.
