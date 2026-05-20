'use client';

import { useEffect, useState } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import { apiClientFetch } from '../../../../lib/api.js';

/**
 * Stripe Elements deposit form (CQA-06). The FIRST Elements integration in
 * the web app — the official, maintained Stripe SDK is the right "borrow"
 * here; we only build the thin wrapper. Built reusable so the (currently
 * stubbed) invoice pay page can later adopt the same component.
 *
 * Flow: POST /deposit-intent → clientSecret → mount <Elements> with it →
 * <PaymentElement> collects the card → confirmPayment(redirect:'if_required')
 * keeps the customer on-page for card payments. The webhook is the source
 * of truth for deposit_paid_at; onPaid() is an optimistic UI flip.
 */

let stripePromiseCache: Promise<Stripe | null> | null = null;
function getStripe(pk: string): Promise<Stripe | null> {
  if (!stripePromiseCache) stripePromiseCache = loadStripe(pk);
  return stripePromiseCache;
}

interface DepositIntentResponse {
  clientSecret: string;
  amountCents: number;
}

function InnerForm({ onPaid }: { onPaid: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function pay(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setErr(null);
    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
    });
    setSubmitting(false);
    if (error) {
      setErr(error.message ?? 'Payment failed.');
      return;
    }
    if (
      paymentIntent &&
      (paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing')
    ) {
      onPaid();
    }
  }

  return (
    <form onSubmit={(e) => void pay(e)} className="mt-4 space-y-3" data-testid="deposit-form">
      <PaymentElement />
      {err && (
        <p className="text-sm text-rose-700" data-testid="deposit-error">
          {err}
        </p>
      )}
      <button
        type="submit"
        disabled={!stripe || submitting}
        data-testid="deposit-pay-button"
        className="w-full rounded-md bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {submitting ? 'Processing…' : 'Pay deposit'}
      </button>
    </form>
  );
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
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await apiClientFetch<DepositIntentResponse>(
        `/api/v1/public/quotes/${token}/deposit-intent`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      if (cancelled) return;
      if (res.status !== 200 || !res.body.ok || !res.body.data?.clientSecret) {
        setError(res.body.error?.message ?? 'Could not start the payment.');
        return;
      }
      setClientSecret(res.body.data.clientSecret);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (error) {
    return (
      <p className="mt-3 text-sm text-rose-700" data-testid="deposit-init-error">
        {error}
      </p>
    );
  }
  if (!clientSecret) {
    return <p className="mt-3 text-sm text-slate-500">Loading payment…</p>;
  }

  return (
    <Elements stripe={getStripe(publishableKey)} options={{ clientSecret }}>
      <InnerForm onPaid={onPaid} />
    </Elements>
  );
}
