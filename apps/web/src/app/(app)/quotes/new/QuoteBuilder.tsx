'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { apiClientFetch } from '../../../../lib/api.js';

export interface CatalogItem {
  sku: string;
  name: string;
  category: string;
}

export interface CustomerLite {
  id: string;
  name: string;
  emailPrimary: string | null;
  phonePrimary: string | null;
}

export interface JobLite {
  id: string;
  customerId: string;
  title: string | null;
}

interface LocalLine {
  /** Stable client-side id; not sent to the API. */
  clientId: string;
  sku: string;
  quantity: number;
  /** Set only by a manager/corporate_admin pencil. */
  overridePct: number | null;
  /** Required by the API when overridePct is set. */
  overrideReason: string;
}

interface PricedLine {
  position: number;
  supplierSku: string;
  description: string | null;
  itemCategory: string | null;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  appliedMarginPct: number;
  appliedMarginSource: string;
}

interface QuoteDetail {
  quote: {
    id: string;
    status: string;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    currencyCode: string;
    supplierQuoteRef?: string | null;
  };
  lineItems: Array<{
    position: number;
    supplierSku: string;
    description: string | null;
    itemCategory: string | null;
    quantity: string;
    unitPriceCents: number;
    lineTotalCents: number;
    appliedMarginPct: string;
    appliedMarginSource: string;
  }>;
}

const MARGIN_SOURCE_BADGE: Record<string, string> = {
  line_override: 'bg-purple-100 text-purple-800',
  category_override: 'bg-amber-100 text-amber-800',
  corporate_default: 'bg-slate-100 text-slate-700',
};

function money(cents: number, currency = 'CAD'): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  });
}

function randId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Live quote builder.
 *
 * Manager + corporate_admin see the cost / margin / override pencil
 * columns; csr / tech / dispatcher do not. The component talks to the
 * `/api/v1/quotes` surface only — no DB-aware logic lives here.
 *
 * Live re-pricing pipeline:
 *   1. Any line edit fires a 300ms debounce.
 *   2. The debounce timer aborts any in-flight `/price` call and starts
 *      a fresh one with an AbortController so an older response can't
 *      clobber a newer one.
 *   3. Errors surface inline on the totals card with a retry button.
 *
 * The commit bar bottom-anchors a "Send to supplier" button; success
 * swaps the bar for a banner that shows the BC supplier quote ref + a
 * "Start another" link.
 */
export function QuoteBuilder({
  role,
  customer,
  job,
  supplierId,
  catalog,
}: {
  role: string;
  customer: CustomerLite | null;
  job: JobLite | null;
  supplierId: string | null;
  catalog: CatalogItem[];
}) {
  const canSeeMargin = role === 'manager' || role === 'corporate_admin';
  const canOverrideMargin = role === 'manager' || role === 'corporate_admin';
  const isManager = role === 'manager';

  const [lines, setLines] = useState<LocalLine[]>([newBlankLine()]);
  const [quoteId, setQuoteId] = useState<string | null>(null);
  const [priced, setPriced] = useState<Map<number, PricedLine>>(new Map());
  const [pricing, setPricing] = useState(false);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [createApiError, setCreateApiError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [committedRef, setCommittedRef] = useState<string | null>(null);
  const [committedQuoteId, setCommittedQuoteId] = useState<string | null>(null);
  const [totals, setTotals] = useState<{
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    currencyCode: string;
  }>({ subtotalCents: 0, taxCents: 0, totalCents: 0, currencyCode: 'CAD' });

  // Pre-condition warning, derived not stored — supplierId being null
  // is a static prop, so a memo is enough; no state churn needed.
  const supplierWarning =
    customer && supplierId === null
      ? 'No supplier selected. Wire a supplier (BC AI Agent) before quoting.'
      : null;
  const createError = createApiError ?? supplierWarning;

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftCreateAttempted = useRef(false);

  function newBlankLine(): LocalLine {
    return {
      clientId: randId(),
      sku: '',
      quantity: 1,
      overridePct: null,
      overrideReason: '',
    };
  }

  // Try to create the draft as soon as we know a customer (and have
  // a supplier when one is wired). When supplierId is null, draft
  // creation is deferred until we wire suppliers — leave a hint in
  // createError so the user understands.
  useEffect(() => {
    if (draftCreateAttempted.current) return;
    if (!customer) return;
    if (supplierId === null) {
      draftCreateAttempted.current = true;
      return;
    }
    draftCreateAttempted.current = true;
    void (async () => {
      const res = await apiClientFetch<{ id: string }>('/api/v1/quotes', {
        method: 'POST',
        body: JSON.stringify({
          customerId: customer.id,
          jobId: job?.id ?? null,
          supplierId,
        }),
      });
      if (res.status !== 201 || !res.body.ok || !res.body.data) {
        setCreateApiError(res.body.error?.message ?? 'Failed to create quote');
        return;
      }
      setQuoteId(res.body.data.id);
    })();
  }, [customer, job, supplierId]);

  function patchLine(clientId: string, patch: Partial<LocalLine>): void {
    setLines((prev) =>
      prev.map((l) => (l.clientId === clientId ? { ...l, ...patch } : l)),
    );
  }

  function removeLine(clientId: string): void {
    setLines((prev) => prev.filter((l) => l.clientId !== clientId));
  }

  function addLine(): void {
    setLines((prev) => [...prev, newBlankLine()]);
  }

  // Debounced re-price whenever lines change. Aborts any in-flight
  // request so an older response can't overwrite the newer state.
  // setState calls happen inside the timer callback / async response,
  // not synchronously in the effect body — keeps react-hooks/set-state-
  // in-effect happy.
  useEffect(() => {
    if (!quoteId) return;
    const ready = lines.filter((l) => l.sku.trim() !== '' && l.quantity > 0);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (ready.length === 0) {
        setTotals((prev) => ({
          subtotalCents: 0,
          taxCents: 0,
          totalCents: 0,
          currencyCode: prev.currencyCode,
        }));
        setPriced(new Map());
        return;
      }
      void doPrice(ready);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // We re-run only on `lines` change (and once quoteId becomes set).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, quoteId]);

  async function doPrice(snapshot: LocalLine[]): Promise<void> {
    if (!quoteId) return;
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setPricing(true);
    setPricingError(null);

    const payload = {
      lineItems: snapshot.map((l) => {
        const base: Record<string, unknown> = {
          sku: l.sku,
          quantity: l.quantity,
        };
        if (l.overridePct !== null) {
          base['marginOverridePct'] = l.overridePct;
          base['marginOverrideReason'] = l.overrideReason;
        }
        return base;
      }),
    };

    const res = await apiClientFetch<QuoteDetail>(
      `/api/v1/quotes/${quoteId}/price`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: ac.signal,
      },
    ).catch((err: unknown) => {
      if ((err as { name?: string })?.name === 'AbortError') return null;
      return {
        status: 0,
        body: {
          ok: false as const,
          error: {
            code: 'NETWORK_ERROR',
            message: err instanceof Error ? err.message : 'Network error',
          },
        },
      };
    });
    if (res === null) return;
    setPricing(false);
    if (res.status !== 200 || !res.body.ok || !res.body.data) {
      // Surface MARGIN_OUT_OF_BOUNDS as a toast so the user knows the
      // configured bounds without scrolling to the totals card. v1
      // uses `alert()` — a real toast lands with the design-system
      // upgrade.
      if (res.body.error?.code === 'MARGIN_OUT_OF_BOUNDS') {
        if (typeof window !== 'undefined') {
          window.alert(`Margin out of bounds: ${res.body.error.message}`);
        }
      }
      setPricingError(res.body.error?.message ?? 'Pricing failed');
      return;
    }
    const detail = res.body.data;
    setTotals({
      subtotalCents: detail.quote.subtotalCents,
      taxCents: detail.quote.taxCents,
      totalCents: detail.quote.totalCents,
      currencyCode: detail.quote.currencyCode,
    });
    const next = new Map<number, PricedLine>();
    for (const li of detail.lineItems) {
      next.set(li.position, {
        position: li.position,
        supplierSku: li.supplierSku,
        description: li.description,
        itemCategory: li.itemCategory,
        quantity: Number(li.quantity),
        unitPriceCents: li.unitPriceCents,
        lineTotalCents: li.lineTotalCents,
        appliedMarginPct: Number(li.appliedMarginPct),
        appliedMarginSource: li.appliedMarginSource,
      });
    }
    setPriced(next);
  }

  async function commit(): Promise<void> {
    if (!quoteId) return;
    setCommitting(true);
    const res = await apiClientFetch<QuoteDetail>(
      `/api/v1/quotes/${quoteId}/commit`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
    setCommitting(false);
    if (res.status !== 200 || !res.body.ok || !res.body.data) {
      setPricingError(res.body.error?.message ?? 'Commit failed');
      return;
    }
    setCommittedRef(res.body.data.quote.supplierQuoteRef ?? null);
    setCommittedQuoteId(res.body.data.quote.id);
  }

  function retry(): void {
    setPricingError(null);
    void doPrice(lines.filter((l) => l.sku.trim() !== ''));
  }

  // Commission preview for managers.
  // TODO(SQB-bridge): swap this naive 4% placeholder for a real
  // `/api/v1/quotes/:id/commission-preview` endpoint that pulls the
  // manager's active comp plan. Until then this is best-effort and
  // hidden from non-managers.
  const commissionCents = isManager
    ? Math.round(totals.totalCents * 0.04)
    : null;

  const canCommit = !!quoteId && totals.subtotalCents > 0 && !pricing && !committedQuoteId;

  return (
    <div className="grid gap-6 lg:grid-cols-3" data-testid="quote-builder">
      <div className="lg:col-span-2 space-y-4">
        <CustomerCard customer={customer} job={job} />
        {createError && (
          <div
            className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
            data-testid="create-error"
          >
            {createError}
          </div>
        )}
        <LineTable
          lines={lines}
          priced={priced}
          catalog={catalog}
          canSeeMargin={canSeeMargin}
          canOverrideMargin={canOverrideMargin}
          onPatch={patchLine}
          onRemove={removeLine}
          pricing={pricing}
        />
        <div className="flex">
          <button
            type="button"
            onClick={addLine}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            data-testid="add-line"
          >
            Add line
          </button>
        </div>
      </div>
      <div className="space-y-4">
        <TotalsCard
          totals={totals}
          pricing={pricing}
          error={pricingError}
          onRetry={retry}
        />
        {isManager && commissionCents !== null && (
          <CommissionPreview
            commissionCents={commissionCents}
            totalCents={totals.totalCents}
            currency={totals.currencyCode}
          />
        )}
      </div>

      <CommitBar
        canCommit={canCommit}
        committing={committing}
        committedRef={committedRef}
        committedQuoteId={committedQuoteId}
        onCommit={commit}
      />
    </div>
  );
}

function CustomerCard({
  customer,
  job,
}: {
  customer: CustomerLite | null;
  job: JobLite | null;
}) {
  if (!customer) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">
        No customer selected. Open this page from a customer or job to
        pre-fill.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500">
        Customer
      </p>
      <p className="mt-1 text-base font-medium text-slate-900">
        {customer.name}
      </p>
      <p className="text-xs text-slate-500">
        {customer.emailPrimary ?? customer.phonePrimary ?? ''}
      </p>
      {job && (
        <p className="mt-2 text-xs text-slate-500">
          Job: {job.title ?? job.id}
        </p>
      )}
    </div>
  );
}

function LineTable({
  lines,
  priced,
  catalog,
  canSeeMargin,
  canOverrideMargin,
  onPatch,
  onRemove,
  pricing,
}: {
  lines: LocalLine[];
  priced: Map<number, PricedLine>;
  catalog: CatalogItem[];
  canSeeMargin: boolean;
  canOverrideMargin: boolean;
  onPatch: (clientId: string, patch: Partial<LocalLine>) => void;
  onRemove: (clientId: string) => void;
  pricing: boolean;
}) {
  return (
    <div
      data-testid="line-table"
      className="overflow-hidden rounded-lg border border-slate-200 bg-white"
    >
      <table className="min-w-full text-sm divide-y divide-slate-200">
        <thead className="bg-slate-50 text-left text-slate-600">
          <tr>
            <th className="px-3 py-2 font-medium w-1/3">SKU</th>
            <th className="px-3 py-2 font-medium">Qty</th>
            <th className="px-3 py-2 font-medium">Unit price</th>
            <th className="px-3 py-2 font-medium">Line total</th>
            {canSeeMargin && <th className="px-3 py-2 font-medium">Margin</th>}
            <th className="px-3 py-2 font-medium" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {lines.map((line, idx) => {
            const p = priced.get(idx);
            return (
              <LineRow
                key={line.clientId}
                line={line}
                priced={p ?? null}
                catalog={catalog}
                canSeeMargin={canSeeMargin}
                canOverrideMargin={canOverrideMargin}
                onPatch={(patch) => onPatch(line.clientId, patch)}
                onRemove={() => onRemove(line.clientId)}
                pricing={pricing}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LineRow({
  line,
  priced,
  catalog,
  canSeeMargin,
  canOverrideMargin,
  onPatch,
  onRemove,
  pricing,
}: {
  line: LocalLine;
  priced: PricedLine | null;
  catalog: CatalogItem[];
  canSeeMargin: boolean;
  canOverrideMargin: boolean;
  onPatch: (patch: Partial<LocalLine>) => void;
  onRemove: () => void;
  pricing: boolean;
}) {
  const [showOverride, setShowOverride] = useState(false);
  const [pctInput, setPctInput] = useState<string>(
    line.overridePct === null ? '' : String(line.overridePct),
  );
  const [reasonInput, setReasonInput] = useState<string>(line.overrideReason);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  const suggestions = useMemo(() => {
    const q = line.sku.trim().toLowerCase();
    if (!q) return [];
    return catalog
      .filter(
        (c) =>
          c.sku.toLowerCase().includes(q) ||
          c.name.toLowerCase().includes(q),
      )
      .slice(0, 10);
  }, [line.sku, catalog]);

  function saveOverride(): void {
    const pct = Number(pctInput);
    if (!Number.isFinite(pct)) {
      setOverrideError('Margin must be a number');
      return;
    }
    if (reasonInput.trim().length === 0) {
      setOverrideError('Reason is required when setting an override');
      return;
    }
    setOverrideError(null);
    onPatch({ overridePct: pct, overrideReason: reasonInput.trim() });
    setShowOverride(false);
  }

  function clearOverride(): void {
    setPctInput('');
    setReasonInput('');
    onPatch({ overridePct: null, overrideReason: '' });
    setShowOverride(false);
  }

  return (
    <tr>
      <td className="px-3 py-2 align-top">
        <input
          type="text"
          value={line.sku}
          onChange={(e) => onPatch({ sku: e.target.value })}
          placeholder="SKU or name"
          className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
          data-testid="sku-input"
          list={`sku-suggestions-${line.clientId}`}
        />
        <datalist id={`sku-suggestions-${line.clientId}`}>
          {suggestions.map((s) => (
            <option key={s.sku} value={s.sku}>
              {s.name}
            </option>
          ))}
        </datalist>
      </td>
      <td className="px-3 py-2 align-top">
        <input
          type="number"
          min={1}
          value={line.quantity}
          onChange={(e) =>
            onPatch({ quantity: Math.max(1, Number(e.target.value) || 1) })
          }
          className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm"
          data-testid="qty-input"
        />
      </td>
      <td
        className={`px-3 py-2 align-top text-slate-700 ${pricing ? 'opacity-50' : ''}`}
      >
        {priced ? money(priced.unitPriceCents) : '—'}
      </td>
      <td className="px-3 py-2 align-top text-slate-900">
        {priced ? money(priced.lineTotalCents) : '—'}
      </td>
      {canSeeMargin && (
        <td className="px-3 py-2 align-top">
          {priced ? (
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
                  MARGIN_SOURCE_BADGE[priced.appliedMarginSource] ??
                  'bg-slate-100 text-slate-700'
                }`}
              >
                {priced.appliedMarginPct}% · {priced.appliedMarginSource}
              </span>
              {canOverrideMargin && (
                <button
                  type="button"
                  onClick={() => setShowOverride((s) => !s)}
                  className="text-xs text-blue-700 hover:underline"
                  data-testid="margin-override-pencil"
                  aria-label="Edit margin override"
                  title="Edit margin override"
                >
                  edit
                </button>
              )}
            </div>
          ) : (
            <span className="text-xs text-slate-400">—</span>
          )}
          {showOverride && canOverrideMargin && (
            <div
              className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2 space-y-2"
              data-testid="margin-override-popover"
            >
              <input
                type="number"
                step="0.01"
                value={pctInput}
                onChange={(e) => setPctInput(e.target.value)}
                placeholder="new %"
                className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs"
              />
              <input
                type="text"
                value={reasonInput}
                onChange={(e) => setReasonInput(e.target.value)}
                placeholder="reason (required)"
                className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs"
                data-testid="margin-override-reason"
              />
              {overrideError && (
                <p className="text-xs text-rose-600">{overrideError}</p>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={saveOverride}
                  className="rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
                  data-testid="margin-override-save"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setShowOverride(false)}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                {line.overridePct !== null && (
                  <button
                    type="button"
                    onClick={clearOverride}
                    className="text-xs text-rose-700 hover:underline"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          )}
        </td>
      )}
      <td className="px-3 py-2 align-top text-right">
        <button
          type="button"
          onClick={onRemove}
          className="text-xs text-rose-700 hover:underline"
          data-testid="remove-line"
          aria-label="Remove line"
        >
          Remove
        </button>
      </td>
    </tr>
  );
}

function TotalsCard({
  totals,
  pricing,
  error,
  onRetry,
}: {
  totals: { subtotalCents: number; taxCents: number; totalCents: number; currencyCode: string };
  pricing: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <div
      className="rounded-lg border border-slate-200 bg-white p-4"
      data-testid="totals-card"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-slate-900">Totals</h2>
        {pricing && (
          <span
            className="text-xs text-slate-500"
            data-testid="pricing-spinner"
          >
            Pricing...
          </span>
        )}
      </div>
      <dl className="mt-3 space-y-1 text-sm">
        <div className="flex justify-between">
          <dt className="text-slate-500">Subtotal</dt>
          <dd className="text-slate-900">
            {money(totals.subtotalCents, totals.currencyCode)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-500">Tax</dt>
          <dd className="text-slate-900">
            {money(totals.taxCents, totals.currencyCode)}
          </dd>
        </div>
        <div className="flex justify-between border-t border-slate-200 pt-1 font-medium">
          <dt className="text-slate-700">Total</dt>
          <dd className="text-slate-900">
            {money(totals.totalCents, totals.currencyCode)}
          </dd>
        </div>
      </dl>
      {error && (
        <div
          className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800"
          data-testid="pricing-error"
        >
          <p>{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 text-rose-900 underline"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

function CommissionPreview({
  commissionCents,
  totalCents,
  currency,
}: {
  commissionCents: number;
  totalCents: number;
  currency: string;
}) {
  if (totalCents === 0) return null;
  const pct = ((commissionCents / totalCents) * 100).toFixed(1);
  return (
    <div
      className="rounded-lg border border-emerald-200 bg-emerald-50 p-4"
      data-testid="commission-preview"
    >
      <p className="text-xs uppercase tracking-wide text-emerald-800">
        Your commission preview
      </p>
      <p className="mt-1 text-lg font-semibold text-emerald-900">
        {money(commissionCents, currency)}{' '}
        <span className="text-sm font-normal">@ {pct}%</span>
      </p>
      <p className="mt-1 text-xs text-emerald-700">
        Placeholder: real preview pulls from your active comp plan.
      </p>
    </div>
  );
}

function CommitBar({
  canCommit,
  committing,
  committedRef,
  committedQuoteId,
  onCommit,
}: {
  canCommit: boolean;
  committing: boolean;
  committedRef: string | null;
  committedQuoteId: string | null;
  onCommit: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="lg:col-span-3 sticky bottom-0 -mx-4 sm:-mx-6 lg:-mx-8 mt-6 border-t border-slate-200 bg-white px-4 sm:px-6 lg:px-8 py-3"
      data-testid="commit-bar"
    >
      {committedQuoteId ? (
        <div
          className="flex items-center justify-between gap-3"
          data-testid="commit-success"
        >
          <div className="text-sm">
            <span className="font-medium text-emerald-700">
              Sent to supplier
            </span>
            {committedRef && (
              <span className="ml-2 text-slate-700">
                Ref: <code className="font-mono">{committedRef}</code>
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {committedRef && (
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(committedRef).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                data-testid="copy-ref"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
            <a
              href="/quotes/new"
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
              data-testid="start-another"
            >
              Start another
            </a>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={onCommit}
            disabled={!canCommit || committing}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid="send-to-supplier"
          >
            {committing ? 'Sending...' : 'Send to supplier'}
          </button>
        </div>
      )}
    </div>
  );
}
