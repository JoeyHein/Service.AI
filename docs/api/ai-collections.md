# AI collections endpoints — phase_ai_collections

Seven endpoints. Dispatch-role (franchisee_owner,
location_manager, dispatcher) or admin only. Tech + CSR → 403.

---

## POST /api/v1/collections/run

Triggers the aging sweep for the caller's franchisee. Platform
+ franchisor admins must be impersonating.

**201 response:**
```json
{
  "ok": true,
  "data": {
    "inspected": 12,
    "drafted": 3,
    "draftIds": ["uuid", "uuid", "uuid"]
  }
}
```

---

## GET /api/v1/collections/drafts?status=

Query: `?status=pending|approved|edited|rejected|sent|failed`.
Scopes: platform sees all, franchisor sees their franchisees,
franchisee-scope sees own.

---

## POST /api/v1/collections/drafts/:id/approve

Sends via the existing `EmailSender` + `SmsSender` adapters.
Missing contact for a channel is a soft-skip; the response
`data.channels: ('email' | 'sms')[]` lists what actually
fired. Status flips to `sent` when at least one channel
succeeded; `failed` when both missing or both raised.

- `409 DRAFT_NOT_PENDING` — draft is not in `pending` or
  `edited` state.

---

## POST /api/v1/collections/drafts/:id/edit

**Body (all optional):**
```json
{
  "smsBody": "...",
  "emailSubject": "...",
  "emailBody": "...",
  "tone": "friendly" | "firm" | "final"
}
```

Status → `edited`. Subsequent approve sends the edited copy.

---

## POST /api/v1/collections/drafts/:id/reject

Status → `rejected` without sending.

---

## GET /api/v1/collections/metrics

```json
{
  "ok": true,
  "data": {
    "dsoDays": 12.3,
    "recoveredRevenueCents": 56000,
    "openInvoiceCents": 240000,
    "totalRevenueCents": 580000
  }
}
```

DSO is `(openReceivables / totalRevenue) * 30` over the
trailing 30 days.

---

## POST /api/v1/payments/retries/:id/run

Admin / dispatch-role only. Creates a fresh PaymentIntent on
the same invoice via the Stripe adapter + stamps the result.

- `409 RETRY_NOT_SCHEDULED` — already succeeded or canceled.
- `404 NOT_FOUND` — cross-tenant row.

---

## Webhook integration

`payment_intent.payment_failed` events now schedule a retry
via `schedulePaymentRetry`. Failure-code → delay table:

| `code` | delay |
|---|---|
| `authentication_required` | 1 hour |
| `card_declined` | 3 days |
| `insufficient_funds` | 5 days |
| `expired_card` | 7 days |
| `processing_error` | 1 hour |
| default | 2 days |

Max 4 attempts per invoice; beyond that the webhook no-ops
(future phase adds human-handoff escalation).

---

## Error codes (phase 12 additions)

| Code | HTTP | Meaning |
|---|---|---|
| `FORBIDDEN`            | 403 | Tech / CSR reached a collections endpoint. |
| `DRAFT_NOT_PENDING`    | 409 | Edit / approve / reject on a non-pending draft. |
| `RETRY_NOT_SCHEDULED`  | 409 | Retry already succeeded / failed / canceled. |
| `NOT_FOUND`            | 404 | Cross-tenant draft or retry id. |
