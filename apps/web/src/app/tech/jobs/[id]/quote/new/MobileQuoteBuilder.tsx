'use client';

/**
 * Mobile-first quote builder for the tech PWA (SQB-09).
 *
 * Same `/api/v1/quotes/*` contract as the office QuoteBuilder, but
 * laid out for a phone:
 *
 *   - Single column. Sticky header (customer + job). Sticky footer
 *     (totals + Send button).
 *   - 44px+ touch targets everywhere.
 *   - Bottom-sheet SKU picker — tap a row to edit, tap "Add part" to
 *     append a fresh line. No inline autocomplete column.
 *   - Offline cache via `localStorage` keyed by quoteId. When
 *     navigator.onLine is false:
 *       * priceItems calls are skipped — we serve the last cached
 *         response and label every line with a "stale" badge.
 *       * commit is blocked with a friendly notice — the button
 *         flips to "Offline · cannot send" and the action is queued
 *         in localStorage for the existing OfflineQueueDrainer to
 *         pick up (or for the user to tap retry when back online).
 *   - Tech role does NOT see margin / cost / commission — same as
 *     the office view's csr / dispatcher tier.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClientFetch } from '../../../../../../lib/api.js';

export interface CatalogItem {
  sku: string;
  name: string;
  category: string;
}

export interface JobLite {
  id: string;
  customerId: string;
  title: string | null;
}

export interface CustomerLite {
  id: string;
  name: string;
  emailPrimary: string | null;
  phonePrimary: string | null;
}

interface LocalLine {
  clientId: string;
  sku: string;
  quantity: number;
}

interface PricedLine {
  position: number;
  supplierSku: string;
  description: string | null;
  itemCategory: string | null;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

interface PriceResponse {
  lineItems: Array<{
    position: number;
    supplierSku: string;
    description: string | null;
    itemCategory: string | null;
    quantity: string;
    unitPriceCents: number;
    lineTotalCents: number;
  }>;
  quote: {
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    currencyCode: string;
  };
}

interface CachedPrice {
  cachedAt: number;
  priced: PricedLine[];
  totals: {
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    currencyCode: string;
  };
}

interface PendingCommit {
  quoteId: string;
  queuedAt: number;
}

const DEBOUNCE_MS = 350;
const PENDING_COMMIT_KEY = 'sai.tech.pending-commit';

function cacheKeyFor(quoteId: string): string {
  return `sai.tech.quote.${quoteId}`;
}

function money(cents: number, currency = 'CAD'): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  });
}

function randId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function newBlankLine(): LocalLine {
  return { clientId: randId(), sku: '', quantity: 1 };
}

/**
 * Read/write a JSON value to localStorage. Quietly no-ops when
 * localStorage isn't available (SSR, denied storage).
 */
function readCache<T>(key: string): T | null {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, value: unknown): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // storage full / denied — silent fallback. The tech still gets
    // a live experience while online; only the offline path degrades.
  }
}

function clearCache(key: string): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(key);
    }
  } catch {
    /* noop */
  }
}

// ---------------------------------------------------------------------------
// Online / offline detection (hook)
// ---------------------------------------------------------------------------

function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = (): void => setOnline(window.navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MobileQuoteBuilder({
  job,
  customer,
  supplierId,
  catalog,
}: {
  job: JobLite;
  customer: CustomerLite | null;
  supplierId: string | null;
  catalog: CatalogItem[];
}) {
  const [lines, setLines] = useState<LocalLine[]>([newBlankLine()]);
  const [quoteId, setQuoteId] = useState<string | null>(null);
  const [priced, setPriced] = useState<PricedLine[]>([]);
  const [pricing, setPricing] = useState(false);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [committedRef, setCommittedRef] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [totals, setTotals] = useState({
    subtotalCents: 0,
    taxCents: 0,
    totalCents: 0,
    currencyCode: 'CAD',
  });
  const [sheet, setSheet] = useState<
    | { kind: 'pick'; targetClientId: string }
    | { kind: 'add' }
    | null
  >(null);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftCreateAttempted = useRef(false);

  const online = useOnline();

  // Friendly supplier-missing notice — same shape as the office view.
  const supplierWarning =
    customer && supplierId === null
      ? 'No supplier wired for this branch yet — quotes cannot be sent.'
      : null;

  // -------------------------------------------------------------------------
  // Draft creation
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (draftCreateAttempted.current) return;
    if (!customer) return;
    if (supplierId === null) {
      draftCreateAttempted.current = true;
      return;
    }
    if (!online) {
      // Can't create a draft offline. Surface a hint; the tech can
      // start tapping line items but nothing will price until back
      // online.
      return;
    }
    draftCreateAttempted.current = true;
    void (async () => {
      const res = await apiClientFetch<{ id: string }>('/api/v1/quotes', {
        method: 'POST',
        body: JSON.stringify({
          customerId: customer.id,
          jobId: job.id,
          supplierId,
        }),
      });
      if (res.status !== 201 || !res.body.ok || !res.body.data) {
        setCreateError(res.body.error?.message ?? 'Failed to create quote');
        return;
      }
      setQuoteId(res.body.data.id);
    })();
  }, [customer, job.id, supplierId, online]);

  // -------------------------------------------------------------------------
  // Load cached prices on mount once we know the quoteId
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!quoteId) return;
    const cached = readCache<CachedPrice>(cacheKeyFor(quoteId));
    if (cached) {
      // One-shot hydration when the quoteId resolves. The cascading-
      // render warning doesn't apply here — this fires once per
      // quoteId, never as a feedback loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPriced(cached.priced);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTotals(cached.totals);
    }
  }, [quoteId]);

  // -------------------------------------------------------------------------
  // Debounced re-price
  // -------------------------------------------------------------------------
  const repriceNow = useCallback(async () => {
    if (!quoteId) return;
    if (!online) {
      setStale(true);
      return;
    }
    const usableLines = lines.filter((l) => l.sku && l.quantity > 0);
    if (usableLines.length === 0) {
      setPriced([]);
      setTotals({ subtotalCents: 0, taxCents: 0, totalCents: 0, currencyCode: 'CAD' });
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPricing(true);
    setPricingError(null);
    try {
      const res = await apiClientFetch<PriceResponse>(
        `/api/v1/quotes/${quoteId}/price`,
        {
          method: 'POST',
          body: JSON.stringify({
            lineItems: usableLines.map((l) => ({
              sku: l.sku,
              quantity: l.quantity,
            })),
          }),
          signal: ctrl.signal,
        },
      );
      if (ctrl.signal.aborted) return;
      if (res.status !== 200 || !res.body.ok || !res.body.data) {
        setPricingError(res.body.error?.message ?? 'Pricing failed');
        return;
      }
      const data = res.body.data;
      const newPriced: PricedLine[] = data.lineItems.map((l) => ({
        position: l.position,
        supplierSku: l.supplierSku,
        description: l.description,
        itemCategory: l.itemCategory,
        quantity: Number(l.quantity),
        unitPriceCents: l.unitPriceCents,
        lineTotalCents: l.lineTotalCents,
      }));
      setPriced(newPriced);
      setTotals(data.quote);
      setStale(false);
      writeCache(cacheKeyFor(quoteId), {
        cachedAt: Date.now(),
        priced: newPriced,
        totals: data.quote,
      } satisfies CachedPrice);
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') return;
      setPricingError((err as Error).message ?? 'Network error');
    } finally {
      if (abortRef.current === ctrl) setPricing(false);
    }
  }, [quoteId, lines, online]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void repriceNow();
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [repriceNow]);

  // -------------------------------------------------------------------------
  // Commit
  // -------------------------------------------------------------------------
  async function commit(): Promise<void> {
    if (!quoteId) return;
    if (!online) {
      // Queue for the OfflineQueueDrainer to pick up. v1 just stores
      // the quoteId; the drainer (or a future tap on this page when
      // back online) finishes the commit.
      const pending: PendingCommit = { quoteId, queuedAt: Date.now() };
      writeCache(PENDING_COMMIT_KEY, pending);
      return;
    }
    setCommitting(true);
    setPricingError(null);
    try {
      const res = await apiClientFetch<{ supplierQuoteRef: string }>(
        `/api/v1/quotes/${quoteId}/commit`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      if (res.status !== 200 || !res.body.ok || !res.body.data) {
        setPricingError(res.body.error?.message ?? 'Commit failed');
        return;
      }
      setCommittedRef(res.body.data.supplierQuoteRef);
      // Once committed, the cache is no longer authoritative — clear
      // it so the next quote starts fresh.
      clearCache(cacheKeyFor(quoteId));
    } finally {
      setCommitting(false);
    }
  }

  // -------------------------------------------------------------------------
  // Line operations
  // -------------------------------------------------------------------------
  function patchLine(clientId: string, patch: Partial<LocalLine>): void {
    setLines((prev) =>
      prev.map((l) => (l.clientId === clientId ? { ...l, ...patch } : l)),
    );
  }

  function removeLine(clientId: string): void {
    setLines((prev) => {
      const next = prev.filter((l) => l.clientId !== clientId);
      return next.length === 0 ? [newBlankLine()] : next;
    });
  }

  function appendLine(sku: string): void {
    setLines((prev) => [...prev, { clientId: randId(), sku, quantity: 1 }]);
  }

  function pricedFor(position: number): PricedLine | undefined {
    return priced.find((p) => p.position === position);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (committedRef) {
    return (
      <div className="min-h-[80vh] flex flex-col items-center justify-center p-6">
        <div
          className="w-full max-w-md rounded-xl bg-emerald-50 border border-emerald-200 p-6 text-center"
          data-testid="quote-committed"
        >
          <div className="text-emerald-700 font-medium text-lg">Quote sent</div>
          <div className="mt-2 text-3xl font-bold tracking-wide text-emerald-900">
            {committedRef}
          </div>
          <div className="mt-1 text-sm text-emerald-700">
            Shared with the supplier — ask the office to confirm.
          </div>
          <div className="mt-6 flex flex-col gap-2">
            <a
              href={`/tech/jobs/${job.id}`}
              className="block rounded-lg bg-emerald-600 text-white py-3 font-medium"
            >
              Back to job
            </a>
            <a
              href={`/tech/jobs/${job.id}/quote/new`}
              className="block rounded-lg border border-emerald-300 text-emerald-700 py-3 font-medium"
            >
              Start another
            </a>
          </div>
        </div>
      </div>
    );
  }

  const headerError = createError ?? supplierWarning;

  return (
    <div className="pb-44">
      {/* Sticky header */}
      <header className="sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-3">
        <div className="text-xs uppercase tracking-wide text-slate-500">New quote</div>
        <div className="text-base font-semibold text-slate-900">
          {customer?.name ?? '(unknown customer)'}
        </div>
        <div className="text-xs text-slate-500">
          Job · {job.title ?? job.id.slice(0, 8)}
        </div>
        {!online && (
          <div
            className="mt-2 rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-xs px-2 py-1"
            data-testid="offline-banner"
          >
            Offline — prices may be stale. Commit is paused.
          </div>
        )}
        {headerError && (
          <div className="mt-2 rounded-md bg-rose-50 border border-rose-200 text-rose-700 text-xs px-2 py-1">
            {headerError}
          </div>
        )}
      </header>

      {/* Lines list */}
      <ul className="divide-y divide-slate-200">
        {lines.map((l) => {
          const p = pricedFor(lines.indexOf(l));
          const cat = catalog.find((c) => c.sku === l.sku);
          return (
            <li
              key={l.clientId}
              className="px-4 py-3 active:bg-slate-50"
              data-testid="quote-line"
            >
              <button
                type="button"
                className="w-full text-left min-h-[44px]"
                onClick={() => setSheet({ kind: 'pick', targetClientId: l.clientId })}
              >
                {l.sku ? (
                  <>
                    <div className="font-medium text-slate-900">
                      {cat?.name ?? l.sku}
                    </div>
                    <div className="text-xs text-slate-500 font-mono">
                      {l.sku}
                    </div>
                  </>
                ) : (
                  <span className="text-blue-700 font-medium">Tap to choose part…</span>
                )}
              </button>
              {l.sku && (
                <div className="mt-2 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        patchLine(l.clientId, { quantity: Math.max(1, l.quantity - 1) })
                      }
                      className="h-11 w-11 rounded-lg border border-slate-300 text-xl text-slate-700"
                      aria-label="Decrease quantity"
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min={1}
                      value={l.quantity}
                      onChange={(e) =>
                        patchLine(l.clientId, {
                          quantity: Math.max(1, Number(e.target.value) || 1),
                        })
                      }
                      className="h-11 w-16 rounded-lg border border-slate-300 text-center text-base tabular-nums"
                    />
                    <button
                      type="button"
                      onClick={() => patchLine(l.clientId, { quantity: l.quantity + 1 })}
                      className="h-11 w-11 rounded-lg border border-slate-300 text-xl text-slate-700"
                      aria-label="Increase quantity"
                    >
                      +
                    </button>
                  </div>
                  <div className="text-right">
                    {p ? (
                      <div className="font-semibold tabular-nums text-slate-900 flex items-center gap-1.5 justify-end">
                        {money(p.lineTotalCents, totals.currencyCode)}
                        {stale && (
                          <span
                            className="text-[10px] uppercase tracking-wide rounded-full bg-amber-100 text-amber-800 px-1.5 py-0.5"
                            data-testid="stale-badge"
                          >
                            stale
                          </span>
                        )}
                      </div>
                    ) : pricing ? (
                      <div className="text-xs text-slate-500">pricing…</div>
                    ) : (
                      <div className="text-xs text-slate-400">—</div>
                    )}
                    <button
                      type="button"
                      onClick={() => removeLine(l.clientId)}
                      className="text-xs text-rose-700 mt-1 min-h-[32px]"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
        <li className="px-4 py-3">
          <button
            type="button"
            onClick={() => setSheet({ kind: 'add' })}
            className="w-full rounded-lg border border-dashed border-slate-300 text-blue-700 font-medium min-h-[44px]"
          >
            + Add part
          </button>
        </li>
      </ul>

      {/* Sticky totals + commit */}
      <footer
        className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-4 py-3 shadow-[0_-2px_8px_rgba(0,0,0,0.04)]"
        data-testid="totals-bar"
      >
        <div className="flex items-baseline justify-between">
          <div className="text-xs uppercase tracking-wide text-slate-500">Total</div>
          <div className="text-2xl font-bold tabular-nums">
            {money(totals.totalCents, totals.currencyCode)}
          </div>
        </div>
        {pricingError && (
          <div className="mt-1 text-xs text-rose-700" role="alert">
            {pricingError}{' '}
            <button
              type="button"
              onClick={() => void repriceNow()}
              className="underline"
            >
              Retry
            </button>
          </div>
        )}
        <button
          type="button"
          disabled={
            !quoteId ||
            !online ||
            committing ||
            pricing ||
            totals.totalCents === 0 ||
            Boolean(headerError)
          }
          onClick={() => void commit()}
          className="mt-2 w-full rounded-lg bg-blue-600 text-white font-semibold py-3 min-h-[44px] disabled:bg-slate-300 disabled:text-slate-500"
          data-testid="commit-button"
        >
          {!online
            ? 'Offline · cannot send'
            : committing
              ? 'Sending…'
              : pricing
                ? 'Pricing…'
                : 'Send to supplier'}
        </button>
      </footer>

      {/* Bottom sheet */}
      {sheet && (
        <SkuPicker
          catalog={catalog}
          onClose={() => setSheet(null)}
          onPick={(sku) => {
            if (sheet.kind === 'pick') {
              patchLine(sheet.targetClientId, { sku });
            } else {
              appendLine(sku);
            }
            setSheet(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bottom-sheet SKU picker
// ---------------------------------------------------------------------------

function SkuPicker({
  catalog,
  onClose,
  onPick,
}: {
  catalog: CatalogItem[];
  onClose: () => void;
  onPick: (sku: string) => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = catalog.filter((c) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      c.sku.toLowerCase().includes(q) ||
      c.name.toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q)
    );
  });
  return (
    <div
      className="fixed inset-0 z-30 flex items-end bg-slate-900/40"
      data-testid="sku-sheet"
      onClick={onClose}
    >
      <div
        className="w-full bg-white rounded-t-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <div className="text-base font-semibold text-slate-900">Pick a part</div>
          <button
            type="button"
            onClick={onClose}
            className="text-blue-700 font-medium min-h-[44px] min-w-[44px]"
          >
            Cancel
          </button>
        </div>
        <div className="px-4 py-2">
          <input
            type="search"
            inputMode="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search SKU, name, category"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-base"
          />
        </div>
        <ul className="overflow-y-auto divide-y divide-slate-100">
          {filtered.map((c) => (
            <li key={c.sku}>
              <button
                type="button"
                className="w-full text-left px-4 py-3 active:bg-slate-100 min-h-[60px]"
                onClick={() => onPick(c.sku)}
              >
                <div className="font-medium text-slate-900">{c.name}</div>
                <div className="text-xs text-slate-500 font-mono">
                  {c.sku} · {c.category}
                </div>
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-4 py-6 text-sm text-slate-500 text-center">
              No parts matched “{query}”.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
