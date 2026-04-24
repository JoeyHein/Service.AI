import { notFound } from 'next/navigation';
import { apiServerFetch } from '../../../../lib/api.js';

interface PublicInvoice {
  status: string;
  subtotal: string;
  taxAmount: string;
  total: string;
  currency: string;
  customerName: string;
  franchiseeName: string;
  paymentIntentId: string | null;
  paidAt: string | null;
}

/**
 * Customer-facing payment page (public, token-authenticated).
 *
 * Renders a minimal invoice summary + a pay button. The full
 * Stripe Elements integration ships in phase_ai_collections when
 * we wire real publishable keys + the Elements SDK; for phase 7
 * the page confirms the happy-path loop (token valid → summary
 * rendered → button present) end-to-end.
 */
export default async function InvoicePayPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const res = await apiServerFetch<PublicInvoice>(
    `/api/v1/public/invoices/${encodeURIComponent(token)}`,
  );
  if (res.status !== 200 || !res.body.ok || !res.body.data) notFound();
  const invoice = res.body.data;
  const paid = invoice.paidAt !== null;

  return (
    <main className="min-h-screen bg-slate-50 py-12 px-4">
      <div className="mx-auto max-w-lg rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">
          {invoice.franchiseeName}
        </h1>
        <p className="mt-1 text-sm text-slate-500">Invoice for {invoice.customerName}</p>

        <dl className="mt-6 space-y-2 text-sm">
          <Row label="Subtotal" value={invoice.subtotal} />
          <Row label="Tax" value={invoice.taxAmount} />
          <div className="mt-2 border-t border-slate-200 pt-2 flex justify-between font-semibold text-slate-900">
            <dt>Total</dt>
            <dd data-testid="pay-total">${Number(invoice.total).toFixed(2)}</dd>
          </div>
        </dl>

        <div className="mt-6">
          {paid ? (
            <div
              role="status"
              className="rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-700"
            >
              Paid — thank you!
            </div>
          ) : (
            <button
              type="button"
              data-testid="pay-button"
              disabled={!invoice.paymentIntentId}
              className="w-full rounded-md bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Pay ${Number(invoice.total).toFixed(2)}
            </button>
          )}
        </div>

        <p className="mt-6 text-xs text-slate-500 text-center">
          Payments processed by Stripe · Service.AI
        </p>
      </div>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-slate-600">
      <dt>{label}</dt>
      <dd>${Number(value).toFixed(2)}</dd>
    </div>
  );
}
