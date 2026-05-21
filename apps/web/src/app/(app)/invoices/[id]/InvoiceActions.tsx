'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';

/**
 * Office invoice actions (OI-03). Finalize a draft (creates the Stripe
 * PaymentIntent), then send it (surfaces the customer pay link). Both reuse
 * the existing invoice-payment endpoints. After each action the server
 * component is refreshed to reflect the new status/token.
 */
export function InvoiceActions({
  invoiceId,
  status,
  paymentLinkToken,
}: {
  invoiceId: string;
  status: string;
  paymentLinkToken: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const payUrl =
    paymentLinkToken && typeof window !== 'undefined'
      ? `${window.location.origin}/invoices/${paymentLinkToken}/pay`
      : null;

  async function act(path: string): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await apiClientFetch(`/api/v1/invoices/${invoiceId}/${path}`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    setBusy(false);
    if (res.status !== 200) {
      setError(res.body.error?.message ?? `${path} failed.`);
      return;
    }
    router.refresh();
  }

  function copyLink(): void {
    if (!payUrl) return;
    void navigator.clipboard.writeText(payUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4" data-testid="invoice-actions">
      {error && (
        <div role="alert" className="mb-3 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {status === 'draft' && (
          <button
            type="button"
            onClick={() => void act('finalize')}
            disabled={busy}
            data-testid="invoice-finalize"
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Finalizing…' : 'Finalize'}
          </button>
        )}
        {status === 'finalized' && (
          <button
            type="button"
            onClick={() => void act('send')}
            disabled={busy}
            data-testid="invoice-send"
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Send to customer'}
          </button>
        )}
        {payUrl && (status === 'sent' || status === 'paid') && (
          <>
            <a
              href={payUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-blue-700 hover:underline"
              data-testid="invoice-pay-link"
            >
              Customer pay link
            </a>
            <button
              type="button"
              onClick={copyLink}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              data-testid="invoice-copy-link"
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </>
        )}
        {status === 'paid' && (
          <span className="text-sm font-medium text-emerald-700">Paid</span>
        )}
      </div>
    </div>
  );
}
