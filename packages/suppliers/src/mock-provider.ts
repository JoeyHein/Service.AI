/**
 * In-memory mock supplier provider. Used by tests + the early-CHR-era
 * prototype before SQB-06 wires BcAiAgentProvider.
 *
 * Design goals:
 *   - Deterministic prices (seed once, get the same result on every call).
 *   - Idempotent commits — the same `externalQuoteId` always returns the
 *     same `supplierQuoteRef`, regardless of how many times you call.
 *   - Optional latency injection so tests can exercise the loading
 *     state of the live-quote UI without an env var dance.
 *   - Failure injection — flip a flag to make the next call return a
 *     structured `SupplierError` so retry paths are testable.
 *
 * The mock keeps its catalog in a Map keyed by sku. Seed with
 * `MockSupplierProvider.seed({ catalog })` before each test, or pass
 * the catalog in the constructor.
 */
import { randomUUID } from 'node:crypto';
import type {
  CommitQuoteRequest,
  CommitQuoteResponse,
  ConvertQuoteToOrderRequest,
  ConvertQuoteToOrderResponse,
  PriceItemsRequest,
  PriceItemsResponse,
  SupplierCatalogEntry,
  SupplierError,
  SupplierLinePrice,
  SupplierProvider,
  SupplierResult,
} from './types.js';

export interface MockCatalogEntry extends SupplierCatalogEntry {
  unitPriceCents: number;
  unitCostCents: number;
}

export interface MockProviderOptions {
  supplierId?: string;
  catalog?: MockCatalogEntry[];
  /** Adds a fixed ms delay before priceItems / commitQuote return. */
  latencyMs?: number;
  /** Currency to return on prices. Defaults to CAD. */
  currency?: 'CAD' | 'USD';
  /** Validity window in days from the call time. Defaults to 30. */
  validityDays?: number;
  /** Tax rate applied to subtotal_cents to produce tax_cents. Default 13% (HST). */
  taxRatePct?: number;
}

/**
 * Mutable failure-injection switch. The mock returns a structured
 * SupplierError on the next call for whichever operation matches.
 * Cleared after a single use so tests don't have to remember to reset.
 */
interface InjectedFailure {
  op: 'price' | 'commit' | 'convertToOrder';
  error: SupplierError;
  /** When true, the failure fires on every call until cleared. */
  sticky: boolean;
}

export class MockSupplierProvider implements SupplierProvider {
  readonly providerKind = 'mock' as const;
  readonly supplierId: string;

  private catalog = new Map<string, MockCatalogEntry>();
  private commits = new Map<string, CommitQuoteResponse>();
  private conversions = new Map<string, ConvertQuoteToOrderResponse>();
  private nextRefSerial = 100_000;
  private nextOrderSerial = 200_000;
  private readonly latencyMs: number;
  private readonly currency: 'CAD' | 'USD';
  private readonly validityDays: number;
  private readonly taxRatePct: number;
  private injectedFailure: InjectedFailure | null = null;
  private voidedRefs = new Set<string>();

  constructor(opts: MockProviderOptions = {}) {
    this.supplierId = opts.supplierId ?? 'mock-supplier';
    this.latencyMs = opts.latencyMs ?? 0;
    this.currency = opts.currency ?? 'CAD';
    this.validityDays = opts.validityDays ?? 30;
    this.taxRatePct = opts.taxRatePct ?? 13;
    if (opts.catalog) this.seedCatalog(opts.catalog);
  }

  /** Replace the catalog. Used between tests to reset state. */
  seedCatalog(entries: MockCatalogEntry[]): void {
    this.catalog = new Map(entries.map((e) => [e.sku, e]));
  }

  /** Append (or upsert) catalog entries without clearing existing ones. */
  upsertCatalog(entries: MockCatalogEntry[]): void {
    for (const e of entries) this.catalog.set(e.sku, e);
  }

  /** Drop every committed quote — used between tests. */
  clearCommits(): void {
    this.commits.clear();
    this.conversions.clear();
    this.voidedRefs.clear();
    this.nextRefSerial = 100_000;
    this.nextOrderSerial = 200_000;
  }

  /** Make the next priceItems / commitQuote / convertQuoteToOrder call fail. */
  injectFailure(
    op: 'price' | 'commit' | 'convertToOrder',
    error: SupplierError,
    sticky = false,
  ): void {
    this.injectedFailure = { op, error, sticky };
  }

  clearInjectedFailure(): void {
    this.injectedFailure = null;
  }

  async priceItems(
    req: PriceItemsRequest,
  ): Promise<SupplierResult<PriceItemsResponse>> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    const fail = this.takeFailure('price');
    if (fail) return { ok: false, error: fail };

    if (req.items.length === 0) {
      return {
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'priceItems requires at least one item',
          retryable: false,
        },
      };
    }

    const currency = req.currency ?? this.currency;
    const validUntil = this.validUntilFromNow();
    const lines: SupplierLinePrice[] = [];
    for (const item of req.items) {
      const cat = this.catalog.get(item.sku);
      if (!cat) {
        // Unknown sku — return zero rather than rejecting the whole
        // batch. The UI surfaces missing SKUs per-line.
        lines.push({
          sku: item.sku,
          quantity: item.quantity,
          unitPriceCents: 0,
          unitCostCents: 0,
          lineTotalCents: 0,
          itemCategory: null,
          description: '(unknown sku)',
          currency,
        });
        continue;
      }
      lines.push({
        sku: cat.sku,
        quantity: item.quantity,
        unitPriceCents: cat.unitPriceCents,
        unitCostCents: cat.unitCostCents,
        lineTotalCents: cat.unitPriceCents * item.quantity,
        itemCategory: cat.category,
        description: cat.name,
        currency,
      });
    }

    const subtotalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
    const taxCents = Math.round((subtotalCents * this.taxRatePct) / 100);
    const totalCents = subtotalCents + taxCents;
    return {
      ok: true,
      data: { items: lines, subtotalCents, taxCents, totalCents, currency, validUntil },
    };
  }

  async commitQuote(
    req: CommitQuoteRequest,
  ): Promise<SupplierResult<CommitQuoteResponse>> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    const fail = this.takeFailure('commit');
    if (fail) return { ok: false, error: fail };

    // Idempotency: same externalQuoteId → same supplierQuoteRef.
    const existing = this.commits.get(req.externalQuoteId);
    if (existing) return { ok: true, data: existing };

    if (req.items.length === 0) {
      return {
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'commitQuote requires at least one item',
          retryable: false,
        },
      };
    }

    this.nextRefSerial += 1;
    const response: CommitQuoteResponse = {
      supplierQuoteRef: `SQ-${String(this.nextRefSerial).padStart(6, '0')}`,
      supplierQuoteId: randomUUID(),
      validUntil: this.validUntilFromNow(),
      currency: req.currency ?? this.currency,
    };
    this.commits.set(req.externalQuoteId, response);
    return { ok: true, data: response };
  }

  async voidQuote(supplierQuoteRef: string): Promise<SupplierResult<void>> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    // Idempotent: voiding a never-committed or already-voided ref is OK.
    this.voidedRefs.add(supplierQuoteRef);
    return { ok: true, data: undefined };
  }

  async convertQuoteToOrder(
    req: ConvertQuoteToOrderRequest,
  ): Promise<SupplierResult<ConvertQuoteToOrderResponse>> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    const fail = this.takeFailure('convertToOrder');
    if (fail) return { ok: false, error: fail };

    // Idempotency: same externalQuoteId → same supplierOrderRef.
    const existing = this.conversions.get(req.externalQuoteId);
    if (existing) return { ok: true, data: existing };

    // The quote must have been committed first — match BC's 422 semantic.
    if (!this.commits.has(req.externalQuoteId)) {
      return {
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: 'No committed quote found for externalQuoteId',
          retryable: false,
        },
      };
    }

    this.nextOrderSerial += 1;
    const response: ConvertQuoteToOrderResponse = {
      supplierOrderRef: `SO-${String(this.nextOrderSerial).padStart(6, '0')}`,
      supplierOrderId: randomUUID(),
      orderedAt: new Date().toISOString(),
    };
    this.conversions.set(req.externalQuoteId, response);
    return { ok: true, data: response };
  }

  /** Test helper — has this quote been converted to an order? */
  isConverted(externalQuoteId: string): boolean {
    return this.conversions.has(externalQuoteId);
  }

  async listCatalog(): Promise<SupplierResult<SupplierCatalogEntry[]>> {
    return {
      ok: true,
      data: Array.from(this.catalog.values()).map(({ sku, name, category, uom }) => ({
        sku,
        name,
        category,
        uom,
      })),
    };
  }

  /** Test helper — was this ref ever voided? */
  isVoided(supplierQuoteRef: string): boolean {
    return this.voidedRefs.has(supplierQuoteRef);
  }

  private takeFailure(
    op: 'price' | 'commit' | 'convertToOrder',
  ): SupplierError | null {
    if (!this.injectedFailure || this.injectedFailure.op !== op) return null;
    const err = this.injectedFailure.error;
    if (!this.injectedFailure.sticky) this.injectedFailure = null;
    return err;
  }

  private validUntilFromNow(): string {
    const t = Date.now() + this.validityDays * 24 * 60 * 60 * 1000;
    return new Date(t).toISOString();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
