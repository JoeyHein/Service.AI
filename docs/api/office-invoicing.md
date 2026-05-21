# Office Invoicing Console (OI) — phase 19

Makes the QF balance invoice operable: the office can list, review, finalize,
and send invoices (balance or plain) and copy the customer pay link. Closes
the loop's last mile (the drafted balance invoice was previously stranded —
no office UI called the finalize/send endpoints). Closes TD-QF-03.

## Surfaces

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/invoices` | **New (OI-01).** Branch-scoped list. Query: `status`, `jobId`, `quoteId`, `limit` (≤200, default 50), `offset`. Per row: id, status, total, customerName, jobTitle, `quoteId` (balance-vs-plain), timestamps, `paymentLinkToken`. Corporate sees all; branch sees its own; cross-branch never leaks. |
| POST | `/api/v1/invoices/:id/finalize` | Reused. draft → finalized; creates the PaymentIntent. |
| POST | `/api/v1/invoices/:id/send` | Reused. finalized → sent; returns `paymentUrl`. |
| PATCH | `/api/v1/invoices/:id` | Reused. Edit draft lines. |

Write actions are the existing invoicing-stripe endpoints — OI adds only the
list endpoint + the office UI.

## Web

- `(app)/invoices` — list with status badges + a "balance" tag for
  quote-linked invoices; status filter; links to detail.
- `(app)/invoices/[id]` — line items (incl the negative "Deposit (paid)"
  credit on a balance invoice), totals, and `InvoiceActions`: **Finalize** →
  **Send** → copy the `/invoices/:token/pay` link. The customer pays through
  the QF-05-wired public pay page.
- Invoices nav link in `AppShell`; the job detail page lists its invoices; the
  QF-06 "balance invoice drafted" banner links here.

## Flow

```
job completed (QF-03) → balance invoice drafted (status=draft)
   │  office opens it from the job banner or the Invoices list
   ▼  Finalize  → finalized (PaymentIntent created for the balance)
   ▼  Send      → sent (pay link surfaced; copy + send to customer)
   ▼  customer pays at /invoices/:token/pay (Stripe Elements)
   ▼  payment_intent.succeeded webhook → paid
       (commission NOT re-credited for quote-linked invoices — QF-04)
```
