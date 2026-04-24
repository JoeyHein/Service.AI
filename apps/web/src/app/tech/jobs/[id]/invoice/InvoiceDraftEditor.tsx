'use client';

/**
 * Invoice draft editor (TASK-TM-05b).
 *
 * Flow:
 *   1. Pick a pricebook item, set a quantity, optional override
 *      price. Client-side floor/ceiling validation gives immediate
 *      feedback; the API re-validates server-side.
 *   2. Add-line appends to a local buffer of edits.
 *   3. Save POSTs (first time) to create the draft, or PATCHes to
 *      replace the full line set; the server re-derives subtotal /
 *      tax / total atomically.
 *
 * Totals are echoed back from the server after each save — they are
 * never computed in the browser, so a code drift can't produce
 * money-shaped bugs here.
 */

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { apiClientFetch } from '../../../../../lib/api.js';

interface PricebookRow {
  serviceItemId: string;
  sku: string;
  name: string;
  category: string;
  basePrice: string;
  effectivePrice: string;
  floorPrice: string | null;
  ceilingPrice: string | null;
}

interface InvoiceLine {
  id?: string;
  serviceItemId: string;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal?: number;
}

interface Invoice {
  id: string;
  status: string;
  subtotal: string;
  taxRate: string;
  taxAmount: string;
  total: string;
  notes: string | null;
  lines: Array<{
    id: string;
    serviceItemId: string | null;
    sku: string;
    name: string;
    quantity: string;
    unitPrice: string;
    lineTotal: string;
  }>;
}

function toNum(v: string | null | undefined, fallback = 0): number {
  const n = v == null ? fallback : Number(v);
  return Number.isFinite(n) ? n : fallback;
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
  const [lines, setLines] = useState<InvoiceLine[]>(() =>
    (initialInvoice?.lines ?? []).map((l) => ({
      id: l.id,
      serviceItemId: l.serviceItemId ?? '',
      sku: l.sku,
      name: l.name,
      quantity: Number(l.quantity),
      unitPrice: Number(l.unitPrice),
      lineTotal: Number(l.lineTotal),
    })),
  );
  const [taxRate, setTaxRate] = useState<number>(
    initialInvoice ? Number(initialInvoice.taxRate) : 0,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [pickerId, setPickerId] = useState<string>(
    pricebook[0]?.serviceItemId ?? '',
  );
  const [qty, setQty] = useState<number>(1);
  const [override, setOverride] = useState<string>('');

  const byId = useMemo(() => {
    const map = new Map<string, PricebookRow>();
    for (const r of pricebook) map.set(r.serviceItemId, r);
    return map;
  }, [pricebook]);

  const current = pickerId ? byId.get(pickerId) : null;

  function addLine() {
    setError(null);
    if (!current) {
      setError('Pick a pricebook item');
      return;
    }
    if (qty <= 0) {
      setError('Quantity must be > 0');
      return;
    }
    const attempted = override.trim() ? Number(override) : toNum(current.effectivePrice);
    if (!Number.isFinite(attempted) || attempted < 0) {
      setError('Unit price is invalid');
      return;
    }
    const floor = current.floorPrice == null ? null : Number(current.floorPrice);
    const ceiling = current.ceilingPrice == null ? null : Number(current.ceilingPrice);
    if (floor !== null && attempted < floor) {
      setError(`Price ${attempted} is below floor ${floor}`);
      return;
    }
    if (ceiling !== null && attempted > ceiling) {
      setError(`Price ${attempted} is above ceiling ${ceiling}`);
      return;
    }
    setLines((prev) => [
      ...prev,
      {
        serviceItemId: current.serviceItemId,
        sku: current.sku,
        name: current.name,
        quantity: qty,
        unitPrice: attempted,
        lineTotal: Math.round(qty * attempted * 100) / 100,
      },
    ]);
    setQty(1);
    setOverride('');
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const payload = {
        lines: lines.map((l) => ({
          serviceItemId: l.serviceItemId,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
        })),
        taxRate,
      };
      if (!invoice) {
        const res = await apiClientFetch<Invoice>(
          `/api/v1/jobs/${jobId}/invoices`,
          { method: 'POST', body: JSON.stringify(payload) },
        );
        if (res.status !== 201 || !res.body.data) {
          setError(res.body.error?.message ?? 'Create failed');
          return;
        }
        setInvoice(res.body.data);
      } else {
        const res = await apiClientFetch<Invoice>(
          `/api/v1/invoices/${invoice.id}`,
          { method: 'PATCH', body: JSON.stringify(payload) },
        );
        if (res.status !== 200 || !res.body.data) {
          setError(res.body.error?.message ?? 'Save failed');
          return;
        }
        setInvoice(res.body.data);
      }
      router.refresh();
    });
  }

  const clientSubtotal =
    Math.round(lines.reduce((acc, l) => acc + (l.lineTotal ?? 0), 0) * 100) / 100;
  const clientTax = Math.round(clientSubtotal * taxRate * 100) / 100;
  const clientTotal = Math.round((clientSubtotal + clientTax) * 100) / 100;

  return (
    <div className="mt-4 space-y-4" data-testid="invoice-editor">
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-medium text-slate-700">Add line</h2>
        <div className="mt-2 flex flex-col sm:flex-row gap-2">
          <select
            value={pickerId}
            onChange={(e) => setPickerId(e.target.value)}
            data-testid="invoice-picker"
            className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm"
          >
            {pricebook.map((r) => (
              <option key={r.serviceItemId} value={r.serviceItemId}>
                {r.sku} — {r.name} (${Number(r.effectivePrice).toFixed(2)})
              </option>
            ))}
          </select>
          <input
            type="number"
            min={0.001}
            step={0.001}
            value={qty}
            onChange={(e) => setQty(Number(e.target.value))}
            className="w-24 rounded border border-slate-300 px-2 py-1.5 text-sm"
            aria-label="Quantity"
          />
          <input
            type="number"
            min={0}
            step={0.01}
            value={override}
            onChange={(e) => setOverride(e.target.value)}
            placeholder={
              current ? `$${Number(current.effectivePrice).toFixed(2)}` : 'Unit price'
            }
            className="w-28 rounded border border-slate-300 px-2 py-1.5 text-sm"
            aria-label="Unit price override"
          />
          <button
            type="button"
            onClick={addLine}
            data-testid="invoice-add-line"
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Add
          </button>
        </div>
        {current && (current.floorPrice || current.ceilingPrice) && (
          <p className="mt-2 text-xs text-slate-500">
            Bounds: {current.floorPrice ? `$${Number(current.floorPrice).toFixed(2)}` : '—'}
            {' '}to{' '}
            {current.ceilingPrice ? `$${Number(current.ceilingPrice).toFixed(2)}` : '—'}
          </p>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-medium text-slate-700">Lines</h2>
        <ul className="mt-2 divide-y divide-slate-100 text-sm">
          {lines.length === 0 ? (
            <li className="py-3 text-slate-500">No lines yet.</li>
          ) : (
            lines.map((l, idx) => (
              <li
                key={`${l.serviceItemId}-${idx}`}
                className="py-2 flex items-start justify-between gap-2"
              >
                <div>
                  <div className="font-medium text-slate-900">{l.name}</div>
                  <div className="text-xs font-mono text-slate-500">
                    {l.sku} · {l.quantity} × ${l.unitPrice.toFixed(2)}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-medium">
                    ${(l.lineTotal ?? 0).toFixed(2)}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeLine(idx)}
                    className="text-xs text-red-700 hover:underline"
                  >
                    remove
                  </button>
                </div>
              </li>
            ))
          )}
        </ul>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <div>
            <label className="block text-xs text-slate-500" htmlFor="taxRate">
              Tax rate (e.g. 0.08 = 8%)
            </label>
            <input
              id="taxRate"
              type="number"
              min={0}
              max={1}
              step={0.001}
              value={taxRate}
              onChange={(e) => setTaxRate(Number(e.target.value))}
              className="mt-1 w-28 rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </div>
          <dl className="text-right text-sm">
            <div className="flex gap-3 justify-between">
              <dt className="text-slate-500">Subtotal</dt>
              <dd>${clientSubtotal.toFixed(2)}</dd>
            </div>
            <div className="flex gap-3 justify-between">
              <dt className="text-slate-500">Tax</dt>
              <dd>${clientTax.toFixed(2)}</dd>
            </div>
            <div className="flex gap-3 justify-between font-medium">
              <dt>Total</dt>
              <dd data-testid="invoice-total">${clientTotal.toFixed(2)}</dd>
            </div>
          </dl>
        </div>
        {error && (
          <div role="alert" className="mt-3 text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={save}
            disabled={pending}
            data-testid="invoice-save"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {pending ? 'Saving…' : invoice ? 'Save draft' : 'Create draft'}
          </button>
        </div>
        {invoice && (
          <p className="mt-2 text-xs text-slate-500 text-right">
            Server total: ${Number(invoice.total).toFixed(2)}
          </p>
        )}
      </div>
    </div>
  );
}
