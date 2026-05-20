'use client';

import { useState } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';
import { CardDepositForm } from './CardDepositForm';

export interface PublicQuoteLine {
  position: number;
  sku: string;
  description: string | null;
  quantity: string;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface PublicQuote {
  status: string;
  branchName: string | null;
  customerName: string;
  currencyCode: string;
  supplierQuoteRef: string | null;
  supplierOrderRef: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  validUntil: string | null;
  expiresAt: string | null;
  depositAmountCents: number | null;
  depositPaidAt: string | null;
  accepted: boolean;
  lineItems: PublicQuoteLine[];
}

function money(cents: number, currency: string): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: currency || 'CAD',
    maximumFractionDigits: 2,
  });
}

/**
 * Handles the customer's Accept action and, when a deposit is due, surfaces
 * the Stripe card form. Acceptance fires immediately on the click (the BC
 * order conversion happens server-side); the deposit is a follow-on step
 * that does not gate acceptance.
 */
export function AcceptPanel({
  token,
  initial,
  publishableKey,
}: {
  token: string;
  initial: PublicQuote;
  publishableKey: string;
}) {
  const [accepted, setAccepted] = useState(initial.accepted);
  const [depositPaid, setDepositPaid] = useState(initial.depositPaidAt !== null);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const depositCents = initial.depositAmountCents;
  const cur = initial.currencyCode;
  const needsDeposit = accepted && depositCents != null && depositCents > 0 && !depositPaid;

  async function accept(): Promise<void> {
    setAccepting(true);
    setError(null);
    const res = await apiClientFetch<PublicQuote>(
      `/api/v1/public/quotes/${token}/accept`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    setAccepting(false);
    if (res.status !== 200 || !res.body.ok) {
      setError(res.body.error?.message ?? 'Could not accept the quote.');
      return;
    }
    setAccepted(true);
    if (res.body.data?.depositPaidAt) setDepositPaid(true);
  }

  return (
    <div
      className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
      data-testid="accept-panel"
    >
      {error && (
        <div
          className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
          data-testid="accept-error"
        >
          {error}
        </div>
      )}

      {!accepted ? (
        <button
          type="button"
          onClick={() => void accept()}
          disabled={accepting}
          data-testid="accept-button"
          className="w-full rounded-md bg-emerald-600 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {accepting ? 'Accepting…' : 'Accept this quote'}
        </button>
      ) : (
        <div
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          data-testid="accepted-banner"
          role="status"
        >
          Quote accepted — thank you!
        </div>
      )}

      {needsDeposit && (
        <div className="mt-6 border-t border-slate-200 pt-6">
          <p className="text-sm font-medium text-slate-900">
            Pay your deposit of {money(depositCents!, cur)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            A deposit secures your order. The balance is due on completion.
          </p>
          {publishableKey ? (
            <CardDepositForm
              token={token}
              publishableKey={publishableKey}
              amountCents={depositCents!}
              currency={cur}
              onPaid={() => setDepositPaid(true)}
            />
          ) : (
            <p className="mt-3 text-xs text-amber-600" data-testid="deposit-unavailable">
              Online deposit payment is not configured. Your branch will follow up.
            </p>
          )}
        </div>
      )}

      {accepted && depositPaid && (
        <div
          className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          data-testid="deposit-paid-banner"
        >
          Deposit paid — thank you!
        </div>
      )}
    </div>
  );
}
