'use client';

import { apiClientFetch } from '../../../../lib/api.js';
import { StripeCardForm } from '../../../../lib/StripeCardForm';

/**
 * Quote deposit card form (CQA-06). Thin wrapper over the shared
 * StripeCardForm: supplies the deposit-intent endpoint as the
 * clientSecret source. The shared component owns Elements + confirmPayment.
 */
interface DepositIntentResponse {
  clientSecret: string;
  amountCents: number;
}

export function CardDepositForm({
  token,
  publishableKey,
  onPaid,
}: {
  token: string;
  publishableKey: string;
  amountCents: number;
  currency: string;
  onPaid: () => void;
}) {
  return (
    <StripeCardForm
      publishableKey={publishableKey}
      payLabel="Pay deposit"
      onPaid={onPaid}
      fetchClientSecret={async () => {
        const res = await apiClientFetch<DepositIntentResponse>(
          `/api/v1/public/quotes/${token}/deposit-intent`,
          { method: 'POST', body: JSON.stringify({}) },
        );
        if (res.status !== 200 || !res.body.ok || !res.body.data?.clientSecret) {
          return { error: res.body.error?.message ?? 'Could not start the payment.' };
        }
        return { clientSecret: res.body.data.clientSecret };
      }}
    />
  );
}
