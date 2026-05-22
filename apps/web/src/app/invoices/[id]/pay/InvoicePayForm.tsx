'use client';

import { useState } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';
import { StripeCardForm } from '../../../../lib/StripeCardForm';

/**
 * Invoice balance card form (QF-05). Replaces the old stub pay button with
 * the shared StripeCardForm, sourcing the clientSecret from the finalized
 * invoice's PaymentIntent. Works for any invoice — a quote balance invoice
 * or a plain service invoice.
 */
interface PaymentIntentResponse {
  clientSecret: string;
  amountCents: number;
}

export function InvoicePayForm({
  token,
  publishableKey,
  alreadyPaid,
}: {
  token: string;
  publishableKey: string;
  alreadyPaid: boolean;
}) {
  const [paid, setPaid] = useState(alreadyPaid);

  if (paid) {
    return (
      <div
        role="status"
        className="rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-700"
        data-testid="invoice-paid-banner"
      >
        Paid — thank you!
      </div>
    );
  }
  if (!publishableKey) {
    return (
      <p className="text-xs text-amber-600" data-testid="pay-unavailable">
        Online payment is not configured. Your branch will follow up.
      </p>
    );
  }

  return (
    <StripeCardForm
      publishableKey={publishableKey}
      payLabel="Pay now"
      onPaid={() => setPaid(true)}
      fetchClientSecret={async () => {
        const res = await apiClientFetch<PaymentIntentResponse>(
          `/api/v1/public/invoices/${token}/payment-intent`,
        );
        if (res.status !== 200 || !res.body.ok || !res.body.data?.clientSecret) {
          return { error: res.body.error?.message ?? 'Could not start the payment.' };
        }
        return { clientSecret: res.body.data.clientSecret };
      }}
    />
  );
}
