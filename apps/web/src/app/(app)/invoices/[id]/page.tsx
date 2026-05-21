import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiServerFetch } from '../../../../lib/api.js';
import { InvoiceActions } from './InvoiceActions';

interface InvoiceLine {
  id: string;
  sku: string;
  name: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
}

interface InvoiceDetail {
  id: string;
  status: string;
  subtotal: string;
  taxAmount: string;
  total: string;
  notes: string | null;
  jobId: string;
  quoteId: string | null;
  paymentLinkToken: string | null;
  lines: InvoiceLine[];
}

function money(v: string): string {
  return Number(v).toLocaleString('en-US', { style: 'currency', currency: 'CAD' });
}

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const res = await apiServerFetch<InvoiceDetail>(`/api/v1/invoices/${id}`);
  if (res.status !== 200 || !res.body.ok || !res.body.data) notFound();
  const inv = res.body.data;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Invoice</h1>
          <p className="mt-1 text-sm text-slate-500">
            Status: <span className="font-mono">{inv.status}</span>
            {inv.quoteId && (
              <span className="ml-2 inline-block rounded bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
                balance invoice
              </span>
            )}
          </p>
        </div>
        <Link href={`/jobs/${inv.jobId}`} className="text-sm text-blue-700 hover:underline">
          View job
        </Link>
      </div>

      <InvoiceActions
        invoiceId={inv.id}
        status={inv.status}
        paymentLinkToken={inv.paymentLinkToken}
      />

      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <table className="min-w-full text-sm divide-y divide-slate-200">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-4 py-2 font-medium">Item</th>
              <th className="px-4 py-2 font-medium text-right">Qty</th>
              <th className="px-4 py-2 font-medium text-right">Unit</th>
              <th className="px-4 py-2 font-medium text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100" data-testid="invoice-lines">
            {inv.lines.map((l) => (
              <tr key={l.id}>
                <td className="px-4 py-2">
                  {l.name}
                  <span className="text-xs text-slate-400"> · {l.sku}</span>
                </td>
                <td className="px-4 py-2 text-right">{Number(l.quantity)}</td>
                <td className="px-4 py-2 text-right">{money(l.unitPrice)}</td>
                <td className="px-4 py-2 text-right">{money(l.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="ml-auto w-full max-w-xs space-y-1 text-sm">
        <div className="flex justify-between text-slate-600">
          <dt>Subtotal</dt>
          <dd>{money(inv.subtotal)}</dd>
        </div>
        <div className="flex justify-between text-slate-600">
          <dt>Tax</dt>
          <dd>{money(inv.taxAmount)}</dd>
        </div>
        <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold text-slate-900">
          <dt>{inv.quoteId ? 'Balance due' : 'Total'}</dt>
          <dd data-testid="invoice-total">{money(inv.total)}</dd>
        </div>
      </dl>

      {inv.notes && <p className="text-xs text-slate-500">{inv.notes}</p>}
    </section>
  );
}
