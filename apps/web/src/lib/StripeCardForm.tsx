'use client';

import { useEffect, useState } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';

/**
 * Shared Stripe Elements card form (CQA-06 + QF-05). The single Elements
 * integration in the web app — used for both the quote deposit and the
 * balance-invoice payment. The caller supplies a `fetchClientSecret`
 * closure (each surface has its own intent endpoint); this component owns
 * the Elements lifecycle + `confirmPayment(redirect:'if_required')`.
 *
 * The server webhook is the source of truth for "paid"; `onPaid` is an
 * optimistic UI flip.
 */

let stripePromiseCache: Promise<Stripe | null> | null = null;
function getStripe(pk: string): Promise<Stripe | null> {
  if (!stripePromiseCache) stripePromiseCache = loadStripe(pk);
  return stripePromiseCache;
}

function InnerForm({ onPaid, payLabel }: { onPaid: () => void; payLabel: string }) {
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
    <form onSubmit={(e) => void pay(e)} className="mt-4 space-y-3" data-testid="card-form">
      <PaymentElement />
      {err && (
        <p className="text-sm text-rose-700" data-testid="card-error">
          {err}
        </p>
      )}
      <button
        type="submit"
        disabled={!stripe || submitting}
        data-testid="card-pay-button"
        className="w-full rounded-md bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {submitting ? 'Processing…' : payLabel}
      </button>
    </form>
  );
}

export function StripeCardForm({
  publishableKey,
  fetchClientSecret,
  payLabel,
  onPaid,
}: {
  publishableKey: string;
  /** Resolves the PaymentIntent clientSecret for the surface being paid. */
  fetchClientSecret: () => Promise<{ clientSecret?: string; error?: string }>;
  payLabel: string;
  onPaid: () => void;
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetchClientSecret();
      if (cancelled) return;
      if (!res.clientSecret) {
        setError(res.error ?? 'Could not start the payment.');
        return;
      }
      setClientSecret(res.clientSecret);
    })();
    return () => {
      cancelled = true;
    };
    // fetchClientSecret is a stable closure from the caller for this token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <p className="mt-3 text-sm text-rose-700" data-testid="card-init-error">
        {error}
      </p>
    );
  }
  if (!clientSecret) {
    return <p className="mt-3 text-sm text-slate-500">Loading payment…</p>;
  }

  return (
    <Elements stripe={getStripe(publishableKey)} options={{ clientSecret }}>
      <InnerForm onPaid={onPaid} payLabel={payLabel} />
    </Elements>
  );
}
