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
  CheckAvailabilityRequest,
  CheckAvailabilityResponse,
  CommitQuoteRequest,
  CommitQuoteResponse,
  ConvertQuoteToOrderRequest,
  ConvertQuoteToOrderResponse,
  CreatePurchaseOrderRequest,
  CreatePurchaseOrderResponse,
  ResolveDoorConfigRequest,
  ResolveDoorConfigResponse,
  PriceItemsRequest,
  PriceItemsResponse,
  SupplierCatalogEntry,
  SupplierError,
  SupplierLinePrice,
  SupplierProvider,
  SupplierResult,
  VoidQuoteRequest,
  VoidQuoteResponse,
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
  op: 'price' | 'commit' | 'convertToOrder' | 'createPurchaseOrder';
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
  private purchaseOrders = new Map<string, CreatePurchaseOrderResponse>();
  private nextRefSerial = 100_000;
  private nextOrderSerial = 200_000;
  private nextPoSerial = 300_000;
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
    this.purchaseOrders.clear();
    this.nextRefSerial = 100_000;
    this.nextOrderSerial = 200_000;
    this.nextPoSerial = 300_000;
  }

  /** Make the next priceItems / commitQuote / convertQuoteToOrder call fail. */
  injectFailure(
    op: 'price' | 'commit' | 'convertToOrder' | 'createPurchaseOrder',
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

  async voidQuote(
    req: VoidQuoteRequest,
  ): Promise<SupplierResult<VoidQuoteResponse>> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    // Idempotent: voiding a never-committed or already-voided id is OK.
    // Track BOTH the external id and the supplier ref so callers using
    // either accessor see a consistent void state.
    this.voidedRefs.add(req.externalQuoteId);
    if (req.supplierQuoteRef) this.voidedRefs.add(req.supplierQuoteRef);
    return {
      ok: true,
      data: {
        supplierQuoteRef: req.supplierQuoteRef,
        voidedAt: new Date().toISOString(),
      },
    };
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

  async checkAvailability(
    req: CheckAvailabilityRequest,
  ): Promise<SupplierResult<CheckAvailabilityResponse>> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    // Deterministic: a catalog SKU has 100 on-hand; an unknown SKU has 0.
    const items = req.items.map((i) => {
      const onHand = this.catalog.has(i.sku) ? 100 : 0;
      const available = onHand;
      const shortfall = Math.max(0, i.quantity - available);
      const status: CheckAvailabilityResponse['items'][number]['status'] =
        shortfall === 0 ? 'available' : available > 0 ? 'partial' : 'unavailable';
      return { sku: i.sku, onHand, available, shortfall, status, leadTimeDays: shortfall > 0 ? 7 : 0 };
    });
    return { ok: true, data: { allAvailable: items.every((i) => i.shortfall === 0), items } };
  }

  async createPurchaseOrder(
    req: CreatePurchaseOrderRequest,
  ): Promise<SupplierResult<CreatePurchaseOrderResponse>> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    const fail = this.takeFailure('createPurchaseOrder');
    if (fail) return { ok: false, error: fail };
    // Idempotency: same externalPoId → same supplierPoRef.
    const existing = this.purchaseOrders.get(req.externalPoId);
    if (existing) return { ok: true, data: existing };
    this.nextPoSerial += 1;
    const response: CreatePurchaseOrderResponse = {
      supplierPoRef: `BCPO-${String(this.nextPoSerial).padStart(6, '0')}`,
      supplierPoId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.purchaseOrders.set(req.externalPoId, response);
    return { ok: true, data: response };
  }

  async resolveDoorConfig(
    req: ResolveDoorConfigRequest,
  ): Promise<SupplierResult<ResolveDoorConfigResponse>> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    // Deterministic: emit a spring + a panel keyed off the config family/size.
    const family = String(req.doorConfig['family'] ?? req.doorConfig['familyId'] ?? 'DOOR');
    return {
      ok: true,
      data: {
        parts: [
          { sku: `${family}-PANEL`, quantity: 1, description: `${family} panel`, category: 'panel' },
          { sku: 'SPRING-STD', quantity: 2, description: 'Torsion spring', category: 'spring' },
        ],
      },
    };
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
    op: 'price' | 'commit' | 'convertToOrder' | 'createPurchaseOrder',
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
