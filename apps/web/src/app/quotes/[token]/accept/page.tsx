import { notFound } from 'next/navigation';
import { apiServerFetch } from '../../../../lib/api.js';
import { AcceptPanel, type PublicQuote } from './AcceptPanel';

/**
 * Customer-facing quote acceptance page (CQA-06). Public + token-gated:
 * the homeowner has no Service.AI account, the 32-byte token in the URL
 * is the auth. Server-renders the quote summary; the AcceptPanel client
 * component handles the Accept action + the Stripe deposit form.
 *
 * Mobile-first — homeowners open these on phones. No app shell / nav.
 */
function money(cents: number, currency: string): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: currency || 'CAD',
    maximumFractionDigits: 2,
  });
}

export default async function QuoteAcceptPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const res = await apiServerFetch<PublicQuote>(
    `/api/v1/public/quotes/${encodeURIComponent(token)}`,
  );
  if (res.status !== 200 || !res.body.ok || !res.body.data) notFound();
  const quote = res.body.data;
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';
  const cur = quote.currencyCode;

  return (
    <main className="min-h-screen bg-slate-50 py-10 px-4">
      <div className="mx-auto max-w-lg space-y-4">
        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-xl font-semibold text-slate-900">
                {quote.branchName}
              </h1>
              <p className="mt-1 text-sm text-slate-500">
                Quote for {quote.customerName}
              </p>
            </div>
            {quote.supplierQuoteRef && (
              <span className="text-xs text-slate-400">{quote.supplierQuoteRef}</span>
            )}
          </div>

          <div className="mt-6 space-y-2" data-testid="quote-lines">
            {quote.lineItems.map((l) => (
              <div key={l.position} className="flex justify-between text-sm">
                <span className="text-slate-700">
                  {l.description ?? l.sku}
                  <span className="text-slate-400">
                    {' '}
                    × {Number(l.quantity)}
                  </span>
                </span>
                <span className="text-slate-900">{money(l.lineTotalCents, cur)}</span>
              </div>
            ))}
          </div>

          <dl className="mt-4 space-y-1 border-t border-slate-200 pt-4 text-sm">
            <Row label="Subtotal" value={money(quote.subtotalCents, cur)} />
            <Row label="Tax" value={money(quote.taxCents, cur)} />
            <div className="flex justify-between pt-1 font-semibold text-slate-900">
              <dt>Total</dt>
              <dd data-testid="quote-total">{money(quote.totalCents, cur)}</dd>
            </div>
          </dl>

          {quote.validUntil && (
            <p className="mt-4 text-xs text-slate-400">
              Valid until {new Date(quote.validUntil).toLocaleDateString()}
            </p>
          )}
        </div>

        <AcceptPanel token={token} initial={quote} publishableKey={publishableKey} />

        <p className="text-center text-xs text-slate-400">
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
      <dd>{value}</dd>
    </div>
  );
}
