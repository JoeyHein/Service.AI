# Invoicing + payments endpoints — phase_invoicing_stripe

Extends the draft invoice surface from phase 6 with Stripe Connect
onboarding, finalize → PaymentIntent, delivery, refund, public-by-
token payment page, and a PDF receipt.

Shared conventions:
- `{ ok: true, data }` on success, `{ ok: false, error }` on failure.
- Cross-tenant access returns `404 NOT_FOUND` (no existence leak).
- Illegal state transitions → `409 INVALID_TRANSITION` with
  `{ from, to }` in the message.

---

## Connect onboarding (franchisor / platform admin only)

### POST /api/v1/franchisees/:id/connect/onboard

Creates (or reuses) the franchisee's Stripe Connect Standard
account and returns a fresh account-link URL for the admin to
hand to the franchisee. Account links expire in ~5 min so this
endpoint is called each time the UI shows the button.

**200:** `{ accountId, onboardingUrl, expiresAt }`

Roles: `platform_admin`, owning `franchisor_admin`. Other roles →
`403 FORBIDDEN`.

### GET /api/v1/franchisees/:id/connect/status

Syncs with Stripe via `retrieveAccount` and returns the current
`chargesEnabled` / `payoutsEnabled` / `detailsSubmitted` booleans.
Updates the local franchisee row if they've drifted.

---

## Invoice state machine

### POST /api/v1/invoices/:id/finalize

Transitions `draft → finalized`. Side effects:
- Creates a Stripe PaymentIntent on the franchisee's connected
  account with `application_fee_amount = round(total * 0.05 * 100)`
  in cents.
- Stamps `stripe_payment_intent_id` + a 32-byte base64url
  `payment_link_token`.
- Returns the invoice plus a `paymentUrl` built from
  `publicBaseUrl`.

**409 STRIPE_NOT_READY** when `stripe_charges_enabled = false`.
**400 EMPTY_INVOICE** when `total = 0`.

### POST /api/v1/invoices/:id/send

Transitions `finalized → sent`. Dispatches the payment URL via
the pluggable `EmailSender` (to customer.email) + `SmsSender`
(to customer.phone). Missing contact is soft-skipped; the
response `data.channels: ('email' | 'sms')[]` lists what
actually fired.

### POST /api/v1/invoices/:id/refund

Refunds a paid invoice (full when `amount` is omitted; partial
otherwise). Exceeding remaining balance → `400
REFUND_OUT_OF_BOUNDS`. Refund on a non-paid invoice → `409
INVALID_TRANSITION`. When the cumulative refunded amount hits
the total, the invoice transitions to `void`.

**Body:**
```json
{ "amount": 42.50, "reason": "customer_request" }
```

**201:** `{ refund: { ... }, invoice: { ... } }`

---

## Stripe webhook

### POST /api/v1/webhooks/stripe

Accepts the raw body with a `stripe-signature` header and
verifies the signature via `StripeClient.constructWebhookEvent`.
Missing header or bad signature → `400 BAD_SIGNATURE` before
any DB work.

Idempotent on `event.id` via a `stripe_events` insert with `ON
CONFLICT DO NOTHING`; replays return `200 { replay: true }`.

Dispatch table (phase 7):

| Type | Effect |
|---|---|
| `payment_intent.succeeded` | insert `payments` row (unique by `stripe_charge_id`), flip invoice → `paid`. |
| `payment_intent.payment_failed` | log only (phase 11 adds collections retry). |
| `charge.refunded` | insert `refunds` row per charge (unique by `stripe_refund_id`). |
| `account.updated` | sync franchisee booleans by `stripe_account_id`. |

---

## Public customer payment surface (no auth)

### GET /api/v1/public/invoices/:token

Token-gated (32-byte base64url, validated against the partial
unique index on `payment_link_token`). Malformed → `400`, unknown
→ `404`.

Returned fields: `status`, `subtotal`, `taxAmount`, `total`,
`currency`, `customerName`, `franchiseeName`, `paymentIntentId`,
`paidAt`. Internal fields (application fee, stripe account id,
line items with overrides) are NOT exposed.

---

## Receipt PDF

### GET /api/v1/invoices/:id/receipt.pdf

Streams `application/pdf` with `content-disposition: inline`.
Draft invoices → `409 INVALID_TRANSITION`. Cross-tenant → `404`.

---

## Error code reference (phase 7 additions)

| Code | HTTP | Meaning |
|---|---|---|
| `STRIPE_NOT_READY`   | 409 | Franchisee hasn't finished Connect onboarding. |
| `EMPTY_INVOICE`      | 400 | Finalize attempted on zero-total invoice. |
| `INVALID_TRANSITION` | 409 | Illegal state machine edge. |
| `MISSING_PAYMENT_LINK` | 409 | Sent path with no payment link — re-finalize. |
| `REFUND_OUT_OF_BOUNDS` | 400 | Amount > remaining balance. |
| `NO_PAYMENT_INTENT`  | 409 | Invoice reached paid without going through finalize. |
| `BAD_SIGNATURE`      | 400 | Stripe webhook signature missing or invalid. |
| `FORBIDDEN`          | 403 | Caller lacks the admin role for a Connect op. |
