/**
 * SupplierProvider contract — the seam through which Service.AI talks to
 * an external supplier (e.g., OPENDC's BC AI Agent for Elevated Doors).
 *
 * The interface is deliberately narrow: two operations, both
 * idempotency-aware. `priceItems` is a read — no side effects, safe to
 * call on every keystroke during a live quote build. `commitQuote` is
 * the write — creates a real document in the supplier's system and
 * returns a reference (e.g., BC's SQ-XXXXXX number).
 *
 * Implementations MUST:
 *   - Honor `idempotencyKey` on commitQuote so retries don't duplicate
 *     supplier-side documents.
 *   - Never throw on transport failures from inside execute(); return
 *     `{ ok: false, error: { code, message, retryable } }` so the agent
 *     loop / route handler can decide retry semantics.
 *   - Return `unit_cost_cents` as the supplier's wholesale price (e.g.,
 *     BC platinum-tier list price for the supplier account). Service.AI's
 *     margin engine layers on top.
 */

/** A single line item the caller wants priced. */
export interface SupplierLineRequest {
  sku: string;
  quantity: number;
  /** Provider-specific extras (size, color, options). Opaque to Service.AI. */
  options?: Record<string, unknown>;
}

/** Pricing result for one line. */
export interface SupplierLinePrice {
  sku: string;
  quantity: number;
  /** What the supplier sells this for under the caller's account. */
  unitPriceCents: number;
  /** Our wholesale cost — never shown to the end customer. */
  unitCostCents: number;
  lineTotalCents: number;
  /** BC `itemCategoryCode` (or equivalent) for margin-override lookup. */
  itemCategory: string | null;
  description: string;
  currency: 'CAD' | 'USD';
}

export interface PriceItemsRequest {
  /** Supplier account code (e.g., Elevated Doors' BC customer number). */
  supplierAccountCode: string;
  items: SupplierLineRequest[];
  /** Optional override; defaults to the supplier's account currency. */
  currency?: 'CAD' | 'USD';
  /**
   * SQB-11 request-ID propagation. Service.AI's Fastify request id is
   * threaded down to the supplier as `X-Request-ID` so one id traces
   * the whole chain — web → Service.AI → BC AI Agent → BC OData. The
   * provider passes it through as an HTTP header.
   */
  requestId?: string;
}

export interface PriceItemsResponse {
  items: SupplierLinePrice[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  currency: 'CAD' | 'USD';
  /** ISO timestamp — when this quote stops being valid. */
  validUntil: string;
}

export interface CommitQuoteRequest {
  supplierAccountCode: string;
  /** Service.AI-side UUID. Used as the supplier's idempotency key — repeat
   *  commits with the same id return the same reference. */
  externalQuoteId: string;
  items: SupplierLineRequest[];
  currency?: 'CAD' | 'USD';
  /** Caller-controlled note appended to the supplier-side document. */
  notes?: string;
  /** SQB-11 request-ID propagation; see PriceItemsRequest.requestId. */
  requestId?: string;
}

export interface CommitQuoteResponse {
  /** Human-facing reference assigned by the supplier (e.g., 'SQ-001391'). */
  supplierQuoteRef: string;
  /** Provider-native UUID for the persisted document. */
  supplierQuoteId: string;
  validUntil: string;
  currency: 'CAD' | 'USD';
}

export interface VoidQuoteRequest {
  /**
   * The SAME `externalQuoteId` used at commit. Drives BC AI Agent's
   * idempotency lookup on `external_quote_commits.external_quote_id`.
   */
  externalQuoteId: string;
  /**
   * The supplier-side quote ref (e.g. BC's `SQ-XXXXXX`). Currently
   * unused by `BcAiAgentProvider.voidQuote` (BC AI Agent looks up the
   * quote via `externalQuoteId`), but kept on the request for logs +
   * for providers that don't store an external-id mapping.
   */
  supplierQuoteRef: string;
  /** Optional human-readable reason persisted alongside `voided_at`. */
  reason?: string;
  /** Forwarded to the supplier as `X-Request-ID` for tracing. */
  requestId?: string;
}

export interface VoidQuoteResponse {
  supplierQuoteRef: string;
  voidedAt: string;
}

export interface ConvertQuoteToOrderRequest {
  /**
   * The SAME `externalQuoteId` that was used at commit time. The provider
   * looks up the supplier-side quote document via this idempotency key,
   * then asks the supplier to convert it to an order. A repeat call with
   * the same id returns the cached order ref.
   */
  externalQuoteId: string;
  /**
   * TD-QOC-A7. Optional HTTP `Idempotency-Key` value forwarded to the
   * supplier. The BC AI Agent endpoint already keys idempotency off the
   * URL path's `external_quote_id`, so this is belt-and-suspenders for
   * reverse-proxy debugging + any future generic replay middleware.
   */
  idempotencyKey?: string;
  /** SQB-11 request-ID propagation; see PriceItemsRequest.requestId. */
  requestId?: string;
}

export interface ConvertQuoteToOrderResponse {
  /** Human-facing supplier order reference (e.g., 'SO-001234'). */
  supplierOrderRef: string;
  /** Provider-native UUID for the persisted order document. */
  supplierOrderId: string;
  /** ISO timestamp — when the supplier created the order. */
  orderedAt: string;
}

export interface CheckAvailabilityRequest {
  supplierAccountCode: string;
  items: SupplierLineRequest[];
  /** SQB-11 request-ID propagation; see PriceItemsRequest.requestId. */
  requestId?: string;
}

export interface AvailabilityLine {
  sku: string;
  /** Supplier on-hand quantity. */
  onHand: number;
  /** On-hand minus already-committed (what we could actually get). */
  available: number;
  /** How much short of the requested quantity (0 if fully available). */
  shortfall: number;
  status: 'available' | 'partial' | 'unavailable';
  /** Estimated lead time to make up a shortfall. */
  leadTimeDays: number;
}

export interface CheckAvailabilityResponse {
  /** True when every line is fully available. */
  allAvailable: boolean;
  items: AvailabilityLine[];
}

export interface CreatePurchaseOrderLine {
  sku: string;
  quantity: number;
  unitCostCents: number;
  description?: string;
}

export interface CreatePurchaseOrderRequest {
  supplierAccountCode: string;
  /**
   * Service.AI-side PO UUID. Used as the supplier's idempotency key — a
   * repeat call with the same id returns the same `supplierPoRef` instead of
   * creating a second BC purchase order.
   */
  externalPoId: string;
  /** Service.AI's human PO number (e.g. 'PO-000123'), for the BC note. */
  poNumber?: string;
  lines: CreatePurchaseOrderLine[];
  /** SQB-11 request-ID propagation. */
  requestId?: string;
  /** Optional HTTP `Idempotency-Key`; defaults to `externalPoId`. */
  idempotencyKey?: string;
}

export interface CreatePurchaseOrderResponse {
  /** Human-facing BC purchase order number (e.g. 'PO-104821'). */
  supplierPoRef: string;
  /** Provider-native UUID for the BC purchase order document. */
  supplierPoId: string;
  /** ISO timestamp — when the supplier created the PO. */
  createdAt: string;
}

export interface ResolveDoorConfigRequest {
  supplierAccountCode: string;
  /** The widget's human/ID door config (open shape; the provider maps it). */
  doorConfig: Record<string, unknown>;
  requestId?: string;
}

export interface DoorConfigPart {
  sku: string;
  quantity: number;
  description?: string;
  category?: string;
}

export interface ResolveDoorConfigResponse {
  parts: DoorConfigPart[];
}

/**
 * Catalog row used by the live-quote autocomplete. Optional helper —
 * providers that don't expose a browsable catalog can return [].
 */
export interface SupplierCatalogEntry {
  sku: string;
  name: string;
  category: string;
  uom?: string;
}

/** Structured error returned by either operation. */
export interface SupplierError {
  code:
    | 'INVALID_REQUEST'
    | 'UNAUTHORIZED'
    | 'NOT_FOUND'
    | 'RATE_LIMITED'
    | 'UPSTREAM_ERROR'
    | 'NETWORK_ERROR'
    | 'IDEMPOTENCY_CONFLICT';
  message: string;
  /** Whether the caller should retry on its own schedule. */
  retryable: boolean;
  /** Provider-specific details — opaque to the agent loop. */
  details?: Record<string, unknown>;
}

export type SupplierResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: SupplierError };

/**
 * The contract every provider implements. Bound to a configured
 * supplier (one `SupplierProvider` instance per row in the `suppliers`
 * table). Auth + endpoint URL are baked in at construction; the
 * methods don't take them as arguments.
 */
export interface SupplierProvider {
  /** Provider kind from the `supplier_provider_kind` enum. */
  readonly providerKind: 'bc_ai_agent' | 'mock';
  /** Stable id of the underlying `suppliers` row, when bound to one. */
  readonly supplierId: string;

  /**
   * Live price lookup. No side effects. Must be safe to call on every
   * keystroke during a live quote build — p95 < 600 ms is the SQB-04
   * latency target at the BC AI Agent boundary.
   */
  priceItems(req: PriceItemsRequest): Promise<SupplierResult<PriceItemsResponse>>;

  /**
   * Create a real supplier-side document for the priced quote. MUST be
   * idempotent on `externalQuoteId`: a repeat call returns the same
   * `supplierQuoteRef`.
   */
  commitQuote(req: CommitQuoteRequest): Promise<SupplierResult<CommitQuoteResponse>>;

  /**
   * Best-effort void of a previously-committed quote. Idempotent on
   * `externalQuoteId` — the same id used at commit; a repeat call
   * returns ok without re-deleting the supplier-side document. Optional
   * on the interface so providers without a void surface can omit it;
   * callers must null-check.
   */
  voidQuote?(req: VoidQuoteRequest): Promise<SupplierResult<VoidQuoteResponse>>;

  /**
   * QOC-02. Convert a committed supplier quote into a supplier order.
   * Triggered by Service.AI's `/api/v1/quotes/:id/accept` after the
   * operator records the customer's acceptance. Idempotent on
   * `externalQuoteId` — the same id used at commit; a repeat call
   * returns the cached order ref without creating a second supplier
   * document. Optional on the interface so mock providers and pre-QOC
   * providers can omit it; the route handler null-checks before invoking.
   */
  convertQuoteToOrder?(
    req: ConvertQuoteToOrderRequest,
  ): Promise<SupplierResult<ConvertQuoteToOrderResponse>>;

  /**
   * TD-INV-01. Read supplier-side stock availability for a basket. No side
   * effects. Optional — providers without an availability surface omit it.
   */
  checkAvailability?(
    req: CheckAvailabilityRequest,
  ): Promise<SupplierResult<CheckAvailabilityResponse>>;

  /**
   * TD-PO-01. Create a real supplier-side purchase order. MUST be idempotent
   * on `externalPoId`: a repeat call returns the same `supplierPoRef` without
   * creating a second supplier document. Optional — callers null-check.
   */
  createPurchaseOrder?(
    req: CreatePurchaseOrderRequest,
  ): Promise<SupplierResult<CreatePurchaseOrderResponse>>;

  /**
   * TD-WI-01. Resolve a door-designer config to concrete supplier SKUs +
   * quantities (so a widget lead can arrive with line items instead of a
   * notes blob). No side effects. Optional — callers null-check.
   */
  resolveDoorConfig?(
    req: ResolveDoorConfigRequest,
  ): Promise<SupplierResult<ResolveDoorConfigResponse>>;

  /**
   * Optional catalog browse — used by the live-quote autocomplete.
   * Providers that lack a browseable catalog return an empty array.
   */
  listCatalog?(): Promise<SupplierResult<SupplierCatalogEntry[]>>;
}
