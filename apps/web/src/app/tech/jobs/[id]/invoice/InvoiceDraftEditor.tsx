'use client';

/**
 * Invoice draft editor (TM-02 shell; TM-05b fleshes out the line
 * editor UX with pricebook picker + override price input).
 *
 * Today it only renders a read-only summary of an existing draft (if
 * any) and surfaces a "Start draft" button that POSTs to the
 * invoice-create endpoint with an empty `lines: []` body. This is
 * enough for TM-02 to validate that the route wiring, layout, and
 * membership gate all work end-to-end; TM-05b adds quantity + price
 * controls, pricebook picker, and an atomic save flow.
 */
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../../lib/api.js';

interface PricebookRow {
  serviceItemId: string;
  sku: string;
  name: string;
  effectivePrice: string;
}

interface Invoice {
  id: string;
  status: string;
  subtotal: string;
  taxAmount: string;
  total: string;
  lines: Array<{
    id: string;
    sku: string;
    name: string;
    quantity: string;
    unitPrice: string;
    lineTotal: string;
  }>;
}

export function InvoiceDraftEditor({
  jobId,
  pricebook,
  initialInvoice,
}: {
  jobId: string;
  pricebook: PricebookRow[];
  initialInvoice: Invoice | null;
}) {
  const router = useRouter();
  const [invoice, setInvoice] = useState<Invoice | null>(initialInvoice);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function startDraft() {
    setError(null);
    startTransition(async () => {
      const res = await apiClientFetch<Invoice>(
        `/api/v1/jobs/${jobId}/invoices`,
        { method: 'POST', body: JSON.stringify({ lines: [] }) },
      );
      if (res.status !== 201 || !res.body.data) {
        setError(res.body.error?.message ?? 'Could not create draft');
        return;
      }
      setInvoice(res.body.data);
      router.refresh();
    });
  }

  if (!invoice) {
    return (
      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
        <p className="text-sm text-slate-600">
          No draft yet for this job. {pricebook.length} pricebook items available.
        </p>
        <button
          type="button"
          onClick={startDraft}
          disabled={pending}
          data-testid="start-invoice-draft"
          className="mt-3 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? 'Creating…' : 'Start draft'}
        </button>
        {error && (
          <div role="alert" className="mt-3 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-mono text-slate-500">
            Draft · {invoice.status}
          </span>
          <span className="text-sm font-medium text-slate-700">
            Total: ${Number(invoice.total).toFixed(2)}
          </span>
        </div>
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {invoice.lines.length === 0 ? (
            <li className="py-3 text-slate-500">
              No line items yet. TM-05b adds the line editor.
            </li>
          ) : (
            invoice.lines.map((l) => (
              <li key={l.id} className="py-2 flex justify-between gap-2">
                <div>
                  <div className="font-medium text-slate-900">{l.name}</div>
                  <div className="text-xs font-mono text-slate-500">{l.sku}</div>
                </div>
                <div className="text-right">
                  <div>
                    {l.quantity} × ${Number(l.unitPrice).toFixed(2)}
                  </div>
                  <div className="font-medium">
                    ${Number(l.lineTotal).toFixed(2)}
                  </div>
                </div>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
