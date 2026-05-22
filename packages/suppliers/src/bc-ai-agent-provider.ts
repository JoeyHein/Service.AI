/**
 * BcAiAgentProvider — first real `SupplierProvider` impl (SQB-06).
 *
 * Talks to BC AI Agent's `/api/external/*` surface (SQB-03..05) with
 * native fetch. No external HTTP dep. Bound to a single `suppliers`
 * row (one BC customer account per provider instance).
 *
 * Retry policy:
 *   - Network-level errors (DNS, ECONNRESET, fetch TypeError) and
 *     5xx responses retry up to `maxRetries` times with exponential
 *     backoff (50ms, 200ms, 800ms).
 *   - 4xx responses do NOT retry — they're caller bugs (bad key,
 *     bad body, account mismatch).
 *   - `commitQuote` retries are SAFE because the BC AI Agent side is
 *     idempotent on `externalQuoteId` (SQB-05). A retry that lands
 *     after the original succeeded returns the cached `SQ-XXXXXX`.
 *
 * Latency budget:
 *   - SQB-04 (price-items) p95 < 600ms at the BC AI Agent boundary.
 *   - With one retry on a 5xx, p99 stays under ~1.4s. Service.AI's
 *     overall p95 < 1.0s budget for the live re-price call has room.
 *
 * Errors are mapped to the structured `SupplierError` envelope. HTTP
 * codes:
 *   401 → UNAUTHORIZED
 *   404 → NOT_FOUND
 *   400 → INVALID_REQUEST
 *   409 → IDEMPOTENCY_CONFLICT (or in-progress; both surface as same)
 *   429 → RATE_LIMITED
 *   5xx → UPSTREAM_ERROR
 *   network → NETWORK_ERROR
 */
import type {
  AvailabilityLine,
  CheckAvailabilityRequest,
  CheckAvailabilityResponse,
  CommitQuoteRequest,
  CommitQuoteResponse,
  ConvertQuoteToOrderRequest,
  ConvertQuoteToOrderResponse,
  CreatePurchaseOrderRequest,
  CreatePurchaseOrderResponse,
  DoorConfigPart,
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
import type {
  SupplierConfig,
  SupplierProviderFactory,
} from './registry.js';

export interface BcAiAgentProviderOptions extends SupplierConfig {
  /** Default 2 retries. 0 disables retry entirely. */
  maxRetries?: number;
  /** Custom fetch (tests inject); defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Per-call timeout in ms. Default 8000. */
  timeoutMs?: number;
  /** Optional Sentry-style hook for instrumentation. */
  onError?: (ctx: {
    operation: 'priceItems' | 'commitQuote' | 'voidQuote' | 'convertQuoteToOrder' | 'checkAvailability' | 'createPurchaseOrder' | 'resolveDoorConfig';
    error: SupplierError;
    attempt: number;
  }) => void;
}

interface BcAiAgentErrorEnvelope {
  ok: false;
  error: {
    code?: string;
    message?: string;
    retryable?: boolean;
  };
}

interface BcAiAgentSuccessEnvelope<T> {
  ok: true;
  data: T;
}

type BcAiAgentResponse<T> = BcAiAgentSuccessEnvelope<T> | BcAiAgentErrorEnvelope;

interface BcPriceLine {
  sku: string;
  quantity: number;
  unitPriceCents: number;
  unitCostCents: number;
  lineTotalCents: number;
  itemCategory: string | null;
  description: string;
  currency: 'CAD' | 'USD';
  priceSource: string;
}

interface BcPriceItemsData {
  items: BcPriceLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  currency: 'CAD' | 'USD';
  validUntil: string;
}

interface BcCommitData {
  supplierQuoteRef: string;
  supplierQuoteId: string;
  validUntil: string;
  currency: 'CAD' | 'USD';
  cached: boolean;
}

interface BcConvertData {
  supplierOrderRef: string;
  supplierOrderId: string;
  orderedAt: string;
  cached: boolean;
}

interface BcVoidData {
  supplierQuoteRef: string;
  voidedAt: string;
  cached: boolean;
}

interface BcAvailabilityData {
  allAvailable: boolean;
  items: AvailabilityLine[];
}

interface BcPurchaseOrderData {
  supplierPoRef: string;
  supplierPoId: string;
  createdAt: string;
  cached: boolean;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 8000;
const BACKOFF_MS = [50, 200, 800];

export class BcAiAgentProvider implements SupplierProvider {
  readonly providerKind = 'bc_ai_agent' as const;
  readonly supplierId: string;

  private readonly endpointUrl: string;
  private readonly apiKey: string;
  private readonly defaultAccountCode: string;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly onError?: BcAiAgentProviderOptions['onError'];

  constructor(opts: BcAiAgentProviderOptions) {
    this.supplierId = opts.supplierId;
    this.endpointUrl = opts.endpointUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.defaultAccountCode = opts.supplierAccountCode;
    this.maxRetries = opts.maxRetries ?? DEFAULT_RETRIES;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onError = opts.onError;
  }

  async priceItems(
    req: PriceItemsRequest,
  ): Promise<SupplierResult<PriceItemsResponse>> {
    const body = {
      supplierAccountCode: req.supplierAccountCode || this.defaultAccountCode,
      items: req.items.map((i) => ({
        sku: i.sku,
        quantity: i.quantity,
        options: i.options ?? undefined,
      })),
      currency: req.currency ?? 'CAD',
    };
    const raw = await this.callWithRetry<BcPriceItemsData>(
      'priceItems',
      '/api/external/price-items',
      body,
      req.requestId,
    );
    if (!raw.ok) return raw;

    const items: SupplierLinePrice[] = raw.data.items.map((line) => ({
      sku: line.sku,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      unitCostCents: line.unitCostCents,
      lineTotalCents: line.lineTotalCents,
      itemCategory: line.itemCategory,
      description: line.description,
      currency: line.currency,
    }));

    return {
      ok: true,
      data: {
        items,
        subtotalCents: raw.data.subtotalCents,
        taxCents: raw.data.taxCents,
        totalCents: raw.data.totalCents,
        currency: raw.data.currency,
        validUntil: raw.data.validUntil,
      },
    };
  }

  async commitQuote(
    req: CommitQuoteRequest,
  ): Promise<SupplierResult<CommitQuoteResponse>> {
    const body = {
      supplierAccountCode: req.supplierAccountCode || this.defaultAccountCode,
      externalQuoteId: req.externalQuoteId,
      items: req.items.map((i) => {
        // commitQuote needs prices — they should have been resolved on
        // the Service.AI side via a prior priceItems call and stored
        // on the quote line. The `options` carrier from the read side
        // is repurposed here to ferry unitPriceCents + description.
        const opts = (i.options ?? {}) as {
          unitPriceCents?: number;
          description?: string;
        };
        return {
          sku: i.sku,
          quantity: i.quantity,
          unitPriceCents: opts.unitPriceCents ?? 0,
          description: opts.description,
        };
      }),
      currency: req.currency ?? 'CAD',
      notes: req.notes,
    };
    const raw = await this.callWithRetry<BcCommitData>(
      'commitQuote',
      '/api/external/quotes',
      body,
      req.requestId,
    );
    if (!raw.ok) return raw;
    return {
      ok: true,
      data: {
        supplierQuoteRef: raw.data.supplierQuoteRef,
        supplierQuoteId: raw.data.supplierQuoteId,
        validUntil: raw.data.validUntil,
        currency: raw.data.currency,
      },
    };
  }

  /**
   * TD-SQB-A8. Void a previously-committed BC quote. Idempotent on
   * `externalQuoteId`; BC AI Agent persists `voided_at` on the same
   * `external_quote_commits` row and short-circuits subsequent calls.
   * Path: POST /api/external/quotes/{external_quote_id}/void
   */
  async voidQuote(
    req: VoidQuoteRequest,
  ): Promise<SupplierResult<VoidQuoteResponse>> {
    const safeId = encodeURIComponent(req.externalQuoteId);
    const body = req.reason ? { reason: req.reason } : {};
    const raw = await this.callWithRetry<BcVoidData>(
      'voidQuote',
      `/api/external/quotes/${safeId}/void`,
      body,
      req.requestId,
    );
    if (!raw.ok) return raw;
    return {
      ok: true,
      data: {
        supplierQuoteRef: raw.data.supplierQuoteRef,
        voidedAt: raw.data.voidedAt,
      },
    };
  }

  /**
   * QOC-02. Convert a committed BC sales quote into a BC sales order.
   * Idempotent on `externalQuoteId` (same as commit): a repeat call
   * returns the cached `SO-XXXXXX` without creating a second BC document.
   * Path: POST /api/external/quotes/{external_quote_id}/convert-to-order
   * (QOC-04 on the BC AI Agent side).
   */
  async convertQuoteToOrder(
    req: ConvertQuoteToOrderRequest,
  ): Promise<SupplierResult<ConvertQuoteToOrderResponse>> {
    // External IDs are server-assigned UUIDs from Service.AI, but be
    // defensive against any caller smuggling a path-traversal payload.
    const safeId = encodeURIComponent(req.externalQuoteId);
    const raw = await this.callWithRetry<BcConvertData>(
      'convertQuoteToOrder',
      `/api/external/quotes/${safeId}/convert-to-order`,
      {},
      req.requestId,
      req.idempotencyKey,
    );
    if (!raw.ok) return raw;
    return {
      ok: true,
      data: {
        supplierOrderRef: raw.data.supplierOrderRef,
        supplierOrderId: raw.data.supplierOrderId,
        orderedAt: raw.data.orderedAt,
      },
    };
  }

  /**
   * TD-INV-01. Read supplier-side stock availability for a basket.
   * Path: POST /api/external/check-availability (BCB-02).
   */
  async checkAvailability(
    req: CheckAvailabilityRequest,
  ): Promise<SupplierResult<CheckAvailabilityResponse>> {
    const body = {
      supplierAccountCode: req.supplierAccountCode || this.defaultAccountCode,
      items: req.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
    };
    const raw = await this.callWithRetry<BcAvailabilityData>(
      'checkAvailability',
      '/api/external/check-availability',
      body,
      req.requestId,
    );
    if (!raw.ok) return raw;
    return { ok: true, data: { allAvailable: raw.data.allAvailable, items: raw.data.items } };
  }

  /**
   * TD-PO-01. Create a real BC purchase order. Idempotent on `externalPoId`
   * (BC AI Agent persists it on `external_purchase_orders`; a replay returns
   * the cached BC PO number).
   * Path: POST /api/external/purchase-orders (BCB-02).
   */
  async createPurchaseOrder(
    req: CreatePurchaseOrderRequest,
  ): Promise<SupplierResult<CreatePurchaseOrderResponse>> {
    const body = {
      supplierAccountCode: req.supplierAccountCode || this.defaultAccountCode,
      externalPoId: req.externalPoId,
      poNumber: req.poNumber,
      lines: req.lines.map((l) => ({
        sku: l.sku,
        quantity: l.quantity,
        unitCostCents: l.unitCostCents,
        description: l.description,
      })),
    };
    const raw = await this.callWithRetry<BcPurchaseOrderData>(
      'createPurchaseOrder',
      '/api/external/purchase-orders',
      body,
      req.requestId,
      req.idempotencyKey ?? req.externalPoId,
    );
    if (!raw.ok) return raw;
    return {
      ok: true,
      data: {
        supplierPoRef: raw.data.supplierPoRef,
        supplierPoId: raw.data.supplierPoId,
        createdAt: raw.data.createdAt,
      },
    };
  }

  /**
   * TD-WI-01. Resolve a door-designer config to BC SKUs + quantities.
   * Path: POST /api/external/door-config/resolve-parts.
   */
  async resolveDoorConfig(
    req: ResolveDoorConfigRequest,
  ): Promise<SupplierResult<ResolveDoorConfigResponse>> {
    const body = {
      supplierAccountCode: req.supplierAccountCode || this.defaultAccountCode,
      doorConfig: req.doorConfig,
    };
    const raw = await this.callWithRetry<{ parts: DoorConfigPart[] }>(
      'resolveDoorConfig',
      '/api/external/door-config/resolve-parts',
      body,
      req.requestId,
    );
    if (!raw.ok) return raw;
    return { ok: true, data: { parts: raw.data.parts } };
  }

  async listCatalog(): Promise<SupplierResult<SupplierCatalogEntry[]>> {
    // Not exposed externally; consumers should use Service.AI's own
    // pricebook for the autocomplete catalog.
    return { ok: true, data: [] };
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  private async callWithRetry<T>(
    operation: 'priceItems' | 'commitQuote' | 'voidQuote' | 'convertQuoteToOrder' | 'checkAvailability' | 'createPurchaseOrder' | 'resolveDoorConfig',
    path: string,
    body: unknown,
    requestId?: string,
    idempotencyKey?: string,
  ): Promise<SupplierResult<T>> {
    let lastError: SupplierError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const result = await this.doFetch<T>(path, body, requestId, idempotencyKey);
      if (result.ok) return result;
      lastError = result.error;
      this.onError?.({ operation, error: result.error, attempt });
      if (!result.error.retryable) return result;
      // Backoff before the next attempt.
      if (attempt < this.maxRetries) {
        const ms = BACKOFF_MS[attempt] ?? 800;
        await sleep(ms);
      }
    }
    return { ok: false, error: lastError ?? unknownError() };
  }

  private async doFetch<T>(
    path: string,
    body: unknown,
    requestId?: string,
    idempotencyKey?: string,
  ): Promise<SupplierResult<T>> {
    const url = `${this.endpointUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // SQB-11: thread the inbound request id through to BC AI Agent
      // so one X-Request-ID traces the whole chain. The header is
      // included only when set — anonymous traffic (tests, smoke
      // probes) doesn't ship a request id.
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Service-AI-Key': this.apiKey,
      };
      if (requestId) headers['X-Request-ID'] = requestId;
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

      const resp = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Parse the envelope. BC AI Agent returns JSON for every status
      // code except a few infrastructure-level errors (nginx 502
      // before FastAPI runs); handle text fallback there.
      let parsed: BcAiAgentResponse<T> | null = null;
      try {
        parsed = (await resp.json()) as BcAiAgentResponse<T>;
      } catch {
        parsed = null;
      }

      if (resp.ok && parsed && parsed.ok === true) {
        return { ok: true, data: parsed.data };
      }

      // Map HTTP status to SupplierError code.
      const code = httpStatusToCode(resp.status);
      const message =
        (parsed && !parsed.ok ? parsed.error?.message : undefined) ??
        `BC AI Agent returned ${resp.status}`;
      const retryable = resp.status >= 500 || resp.status === 429;
      return {
        ok: false,
        error: {
          code,
          message,
          retryable,
          details: parsed ? ({ envelope: parsed } as Record<string, unknown>) : undefined,
        },
      };
    } catch (err: unknown) {
      // Network-level failure (DNS, ECONNRESET, AbortError on timeout, etc.).
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' || /aborted/i.test(err.message));
      return {
        ok: false,
        error: {
          code: 'NETWORK_ERROR',
          message: isAbort
            ? `BC AI Agent request timed out after ${this.timeoutMs}ms`
            : `BC AI Agent network error: ${(err as Error).message ?? 'unknown'}`,
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpStatusToCode(status: number): SupplierError['code'] {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 400 || status === 422) return 'INVALID_REQUEST';
  if (status === 409) return 'IDEMPOTENCY_CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_ERROR';
  return 'UPSTREAM_ERROR';
}

function unknownError(): SupplierError {
  return {
    code: 'UPSTREAM_ERROR',
    message: 'BC AI Agent call failed without a recorded error',
    retryable: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Factory for the ProviderRegistry. Registers under provider_kind
 * `bc_ai_agent`. Service.AI's app boot calls:
 *
 *     registry.registerFactory('bc_ai_agent', bcAiAgentFactory);
 *     registry.bind({ supplierId, providerKind: 'bc_ai_agent', ... });
 */
export const bcAiAgentFactory: SupplierProviderFactory = (config) =>
  new BcAiAgentProvider(config);
