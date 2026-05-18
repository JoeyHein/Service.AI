/**
 * Supplier-quote routes (SQB-07c).
 *
 *   POST   /api/v1/quotes               create draft
 *   POST   /api/v1/quotes/:id/price     re-price (replaces lines)
 *   POST   /api/v1/quotes/:id/commit    send to supplier + write commission
 *   POST   /api/v1/quotes/:id/void      void + reverse commission
 *   GET    /api/v1/quotes/:id           full detail with last 10 status_log
 *   GET    /api/v1/quotes               list (branch-scoped filter)
 *
 * Wires the three already-shipped engines together:
 *   - `resolveSellingPrice` (margin-engine.ts)
 *   - `canTransition` (quote-status-machine.ts)
 *   - `onQuoteCommitted` / `reverseQuoteCommitted` (commission-engine.ts)
 *
 * Cost trust: `unitCostCents` is read from the supplier provider's
 * `priceItems` response in the SAME request that writes
 * `quote_line_items`. Client-supplied cost fields are ignored.
 *
 * Auth model: `requireScope()`-style — every endpoint resolves
 * `req.scope`. Branch-scoped users see only their own branch's quotes;
 * corporate_admin sees all. Cross-branch probes return 404 (never 403)
 * per the project's defence-in-depth rule.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  auditLog,
  corporate as corporateTable,
  marginOverrides,
  quotes,
  quoteLineItems,
  quoteStatusLog,
  suppliers,
  withScope,
  type RequestScope,
  type ScopedTx,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import {
  ProviderRegistry,
  bcAiAgentFactory,
  type SupplierProvider,
  type SupplierLineRequest,
  type SupplierLinePrice,
} from '@service-ai/suppliers';
import {
  resolveSellingPrice,
  totalsFor,
  type MarginPolicy,
  type MarginSource,
} from './margin-engine.js';
import {
  canTransition,
  type QuoteStatus,
} from './quote-status-machine.js';
import { onQuoteCommitted, reverseQuoteCommitted } from './commission-engine.js';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const CreateQuoteSchema = z.object({
  customerId: z.string().uuid(),
  jobId: z.string().uuid().nullable().optional(),
  supplierId: z.string().uuid(),
  currency: z.enum(['CAD', 'USD']).optional(),
});

const LineItemSchema = z.object({
  sku: z.string().min(1),
  description: z.string().optional(),
  quantity: z.number().positive(),
  itemCategory: z.string().nullable().optional(),
  marginOverridePct: z.number().nullable().optional(),
  marginOverrideReason: z.string().nullable().optional(),
});
type LineItemInput = z.infer<typeof LineItemSchema>;

const PriceQuoteSchema = z.object({
  lineItems: z.array(LineItemSchema).optional(),
});

const CommitQuoteSchema = z.object({
  idempotencyKey: z.string().min(1).optional(),
});

const VoidQuoteSchema = z.object({
  reason: z.string().max(500).nullable().optional(),
});

const AcceptQuoteSchema = z.object({
  acknowledgmentChannel: z
    .enum(['verbal_phone', 'verbal_inperson', 'signed_pdf', 'other'])
    .optional(),
  notes: z.string().max(500).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inScope(scope: RequestScope, branchId: string): boolean {
  if (scope.type === 'corporate') return true;
  return scope.branchId === branchId;
}

function isManagerOrAbove(scope: RequestScope): boolean {
  if (scope.type === 'corporate') return true;
  return scope.role === 'manager';
}

/**
 * Read the singleton corporate row's margin policy. The corporate table
 * is required to contain exactly one row in the v1 model; if it is
 * empty we fall back to safe defaults so the route doesn't 500 in
 * partially-seeded test environments.
 */
async function loadMarginPolicy(tx: ScopedTx): Promise<MarginPolicy> {
  const rows = await tx
    .select({
      defaultPct: corporateTable.defaultMarginPct,
      minPct: corporateTable.minMarginPct,
      maxPct: corporateTable.maxMarginPct,
    })
    .from(corporateTable)
    .limit(1);
  const r = rows[0];
  if (!r) {
    return { defaultPct: 60, minPct: 20, maxPct: 200 };
  }
  return {
    defaultPct: Number(r.defaultPct),
    minPct: Number(r.minPct),
    maxPct: Number(r.maxPct),
  };
}

/**
 * Look up category overrides for the given set of item categories in a
 * single IN(...) query. Returns a Map from itemCategory string ->
 * marginPct (already coerced to number).
 */
async function loadCategoryMargins(
  tx: ScopedTx,
  categories: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (categories.length === 0) return map;
  const rows = await tx
    .select({
      itemCategory: marginOverrides.itemCategory,
      marginPct: marginOverrides.marginPct,
    })
    .from(marginOverrides)
    .where(inArray(marginOverrides.itemCategory, categories));
  for (const r of rows) {
    map.set(r.itemCategory, Number(r.marginPct));
  }
  return map;
}

/**
 * Resolve the SupplierProvider for a supplier row. Reads the API key
 * from `process.env[apiKeySecretRef]` (falls back to '' when unset).
 */
function bindProvider(
  registry: ProviderRegistry,
  supplier: {
    id: string;
    providerKind: string;
    endpointUrl: string;
    apiKeySecretRef: string;
    supplierAccountCode: string;
  },
): SupplierProvider {
  const apiKey = process.env[supplier.apiKeySecretRef] ?? '';
  return registry.bind({
    supplierId: supplier.id,
    // The `provider_kind` enum currently only has 'bc_ai_agent', but the
    // registry also accepts 'mock' for tests. Cast through the wider type.
    providerKind: supplier.providerKind as 'bc_ai_agent' | 'mock',
    endpointUrl: supplier.endpointUrl,
    apiKey,
    supplierAccountCode: supplier.supplierAccountCode,
  });
}

interface ResolvedQuoteLine {
  position: number;
  sku: string;
  description: string;
  itemCategory: string | null;
  quantity: number;
  unitCostCents: number;
  unitPriceCents: number;
  lineTotalCents: number;
  appliedMarginPct: number;
  appliedMarginSource: MarginSource;
  marginOverridePct: number | null;
  marginOverrideReason: string | null;
}

interface ResolveLinesError {
  code:
    | 'OVERRIDE_NOT_PERMITTED'
    | 'OVERRIDE_REASON_REQUIRED'
    | 'MARGIN_OUT_OF_BOUNDS'
    | 'UPSTREAM_ERROR'
    | 'INVALID_REQUEST'
    | 'NETWORK_ERROR'
    | 'UNAUTHORIZED'
    | 'NOT_FOUND'
    | 'RATE_LIMITED'
    | 'IDEMPOTENCY_CONFLICT';
  status: number;
  message: string;
}

/**
 * Run the full per-line resolution pipeline:
 *   1. Validate overrides against role + reason rules.
 *   2. Batch-call the supplier provider.
 *   3. Look up category margins in one IN query.
 *   4. Call `resolveSellingPrice` per line.
 *
 * Returns either the resolved lines (in input order) or a structured
 * error the route layer maps to an HTTP status.
 */
async function resolveLines(
  tx: ScopedTx,
  provider: SupplierProvider,
  supplierAccountCode: string,
  inputs: LineItemInput[],
  scope: RequestScope,
  policy: MarginPolicy,
  requestId?: string,
): Promise<
  | { ok: true; lines: ResolvedQuoteLine[]; currency: 'CAD' | 'USD' }
  | { ok: false; error: ResolveLinesError }
> {
  // Pre-flight: override permissions + reason. Manager-or-above can set
  // a per-line override; everyone else must omit the field. A set
  // override needs a non-empty reason.
  for (const ln of inputs) {
    const hasOverride =
      ln.marginOverridePct !== null && ln.marginOverridePct !== undefined;
    if (hasOverride && !isManagerOrAbove(scope)) {
      return {
        ok: false,
        error: {
          code: 'OVERRIDE_NOT_PERMITTED',
          status: 403,
          message: 'Only managers and corporate admins can set per-line margin overrides',
        },
      };
    }
    if (hasOverride) {
      const reason = (ln.marginOverrideReason ?? '').trim();
      if (reason.length === 0) {
        return {
          ok: false,
          error: {
            code: 'OVERRIDE_REASON_REQUIRED',
            status: 422,
            message: 'marginOverrideReason is required when marginOverridePct is set',
          },
        };
      }
    }
  }

  // Single batched call to the supplier. The route doesn't price lines
  // one at a time — the supplier round-trip dominates the latency
  // budget, so we hand it the whole basket.
  const supplierItems: SupplierLineRequest[] = inputs.map((ln) => ({
    sku: ln.sku,
    quantity: ln.quantity,
  }));
  const priceRes = await provider.priceItems({
    supplierAccountCode,
    items: supplierItems,
    requestId,
  });
  if (!priceRes.ok) {
    const code = priceRes.error.code;
    let status = 502;
    if (code === 'INVALID_REQUEST') status = 400;
    else if (code === 'UNAUTHORIZED') status = 401;
    else if (code === 'NOT_FOUND') status = 404;
    else if (code === 'RATE_LIMITED') status = 429;
    else if (code === 'IDEMPOTENCY_CONFLICT') status = 409;
    return {
      ok: false,
      error: { code, status, message: priceRes.error.message },
    };
  }

  // Bucket the supplier prices by sku+quantity index. Provider returns
  // the same order it was given (mock + bc-ai-agent both honor this).
  const supplierLines: SupplierLinePrice[] = priceRes.data.items;

  // Determine category set. Lines that explicitly set itemCategory win
  // over the supplier-derived value (managers may classify a line into
  // a different bucket than BC's catalog).
  const categories = new Set<string>();
  for (let i = 0; i < inputs.length; i += 1) {
    const cat =
      inputs[i]!.itemCategory !== undefined
        ? inputs[i]!.itemCategory
        : supplierLines[i]?.itemCategory ?? null;
    if (cat) categories.add(cat);
  }
  const categoryMap = await loadCategoryMargins(tx, Array.from(categories));

  const resolved: ResolvedQuoteLine[] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i]!;
    const supplied = supplierLines[i];
    const unitCostCents = supplied?.unitCostCents ?? 0;
    const itemCategory =
      input.itemCategory !== undefined
        ? input.itemCategory
        : supplied?.itemCategory ?? null;
    const lineOverridePct =
      input.marginOverridePct === null || input.marginOverridePct === undefined
        ? null
        : input.marginOverridePct;
    const categoryMarginPct =
      itemCategory && categoryMap.has(itemCategory)
        ? categoryMap.get(itemCategory)!
        : null;

    const result = resolveSellingPrice({
      unitCostCents,
      itemCategory,
      lineOverridePct,
      categoryMarginPct,
      policy,
    });
    if (!result.ok) {
      const status = result.error === 'MARGIN_OUT_OF_BOUNDS' ? 422 : 400;
      return {
        ok: false,
        error: {
          code: result.error === 'MARGIN_OUT_OF_BOUNDS'
            ? 'MARGIN_OUT_OF_BOUNDS'
            : 'INVALID_REQUEST',
          status,
          message: result.message,
        },
      };
    }
    const qty = input.quantity;
    resolved.push({
      position: i,
      sku: input.sku,
      description: input.description ?? supplied?.description ?? input.sku,
      itemCategory,
      quantity: qty,
      unitCostCents,
      unitPriceCents: result.unitPriceCents,
      lineTotalCents: result.unitPriceCents * qty,
      appliedMarginPct: result.marginPct,
      appliedMarginSource: result.marginSource,
      marginOverridePct: lineOverridePct,
      marginOverrideReason:
        lineOverridePct !== null ? (input.marginOverrideReason ?? '').trim() : null,
    });
  }

  return { ok: true, lines: resolved, currency: priceRes.data.currency };
}

/**
 * Fetch a quote + its lines + the last N status_log rows. Pure read;
 * caller wraps in `withScope`.
 */
async function loadQuoteDetail(
  tx: ScopedTx,
  quoteId: string,
  scope: RequestScope,
): Promise<
  | {
      quote: typeof quotes.$inferSelect;
      lineItems: (typeof quoteLineItems.$inferSelect)[];
      statusLog: (typeof quoteStatusLog.$inferSelect)[];
    }
  | null
> {
  const qRows = await tx.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
  const q = qRows[0];
  if (!q) return null;
  if (!inScope(scope, q.branchId)) return null;

  const lines = await tx
    .select()
    .from(quoteLineItems)
    .where(eq(quoteLineItems.quoteId, quoteId))
    .orderBy(quoteLineItems.position);
  const log = await tx
    .select()
    .from(quoteStatusLog)
    .where(eq(quoteStatusLog.quoteId, quoteId))
    .orderBy(desc(quoteStatusLog.createdAt))
    .limit(10);
  return { quote: q, lineItems: lines, statusLog: log };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface QuoteRoutesDeps {
  drizzle: Drizzle;
  providerRegistry: ProviderRegistry;
}

/**
 * Default factory: build a registry with the canonical bc_ai_agent
 * factory registered. Tests pass their own pre-seeded registry that
 * additionally registers the mock factory.
 */
export function defaultProviderRegistry(): ProviderRegistry {
  const r = new ProviderRegistry();
  r.registerFactory('bc_ai_agent', bcAiAgentFactory);
  return r;
}

export function registerQuoteRoutes(
  app: FastifyInstance,
  deps: QuoteRoutesDeps,
): void {
  const { drizzle: db, providerRegistry: registry } = deps;

  // -------------------------------------------------------------------------
  // POST /api/v1/quotes — create draft
  // -------------------------------------------------------------------------
  app.post('/api/v1/quotes', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const parsed = CreateQuoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
    }
    const scope = req.scope;

    const outcome = await withScope(db, scope, async (tx) => {
      // Resolve the customer's branch (corporate admins must use a
      // customer in the corporate hub; branch users only their own).
      const custRows = await tx
        .select({ id: schema.customers.id, branchId: schema.customers.branchId })
        .from(schema.customers)
        .where(eq(schema.customers.id, parsed.data.customerId))
        .limit(1);
      const cust = custRows[0];
      if (!cust) return { kind: 'customer_missing' as const };
      if (!inScope(scope, cust.branchId)) {
        return { kind: 'customer_missing' as const };
      }
      // Verify the supplier exists. The supplier table is corporate-
      // scoped so any branch may target it.
      const supRows = await tx
        .select()
        .from(suppliers)
        .where(eq(suppliers.id, parsed.data.supplierId))
        .limit(1);
      if (!supRows[0]) return { kind: 'supplier_missing' as const };

      const inserted = await tx
        .insert(quotes)
        .values({
          branchId: cust.branchId,
          customerId: parsed.data.customerId,
          jobId: parsed.data.jobId ?? null,
          supplierId: parsed.data.supplierId,
          status: 'draft',
          subtotalCents: 0,
          taxCents: 0,
          totalCents: 0,
          currencyCode: parsed.data.currency ?? 'CAD',
          createdByUserId: scope.userId,
        })
        .returning();
      return { kind: 'ok' as const, quote: inserted[0]! };
    });

    if (outcome.kind === 'customer_missing') {
      return reply.code(404).send({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Customer not found' },
      });
    }
    if (outcome.kind === 'supplier_missing') {
      return reply.code(404).send({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Supplier not found' },
      });
    }
    return reply.code(201).send({
      ok: true,
      data: { ...outcome.quote, lineItems: [] },
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/quotes/:id/price — replace lines + re-price
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/quotes/:id/price',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const parsed = PriceQuoteSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const scope = req.scope;

      const outcome = await withScope(db, scope, async (tx) => {
        const qRows = await tx
          .select()
          .from(quotes)
          .where(eq(quotes.id, req.params.id))
          .limit(1);
        const q = qRows[0];
        if (!q) return { kind: 'not_found' as const };
        if (!inScope(scope, q.branchId)) return { kind: 'not_found' as const };

        const from = q.status as QuoteStatus;
        if (!canTransition(from, 'priced')) {
          return { kind: 'invalid_transition' as const, from, to: 'priced' as const };
        }

        // Resolve the supplier provider for this quote.
        const supRows = await tx
          .select()
          .from(suppliers)
          .where(eq(suppliers.id, q.supplierId))
          .limit(1);
        const sup = supRows[0];
        if (!sup) return { kind: 'supplier_missing' as const };
        const provider = bindProvider(registry, sup);

        const policy = await loadMarginPolicy(tx);
        const lineInputs: LineItemInput[] = parsed.data.lineItems ?? [];
        if (lineInputs.length === 0) {
          return { kind: 'no_lines' as const };
        }

        const resolution = await resolveLines(
          tx,
          provider,
          sup.supplierAccountCode,
          lineInputs,
          scope,
          policy,
          String(req.id),
        );
        if (!resolution.ok) return { kind: 'resolve_error' as const, error: resolution.error };

        // Replace-all line items. Cascade delete + re-insert keeps
        // ordering trivially consistent and avoids juggling UPSERT keys
        // when the client reorders rows.
        await tx
          .delete(quoteLineItems)
          .where(eq(quoteLineItems.quoteId, q.id));
        if (resolution.lines.length > 0) {
          await tx.insert(quoteLineItems).values(
            resolution.lines.map((ln) => ({
              quoteId: q.id,
              branchId: q.branchId,
              position: ln.position,
              supplierSku: ln.sku,
              description: ln.description,
              itemCategory: ln.itemCategory,
              quantity: String(ln.quantity),
              unitPriceCents: ln.unitPriceCents,
              lineTotalCents: ln.lineTotalCents,
              supplierUnitCostCents: ln.unitCostCents,
              appliedMarginPct: String(ln.appliedMarginPct),
              appliedMarginSource: ln.appliedMarginSource,
              marginOverridePct:
                ln.marginOverridePct !== null
                  ? String(ln.marginOverridePct)
                  : null,
              marginOverrideReason: ln.marginOverrideReason,
            })),
          );
        }
        const totals = totalsFor(
          resolution.lines.map((ln) => ({
            unitPriceCents: ln.unitPriceCents,
            quantity: ln.quantity,
          })),
        );
        await tx
          .update(quotes)
          .set({
            status: 'priced',
            subtotalCents: totals.subtotalCents,
            taxCents: totals.taxCents,
            totalCents: totals.totalCents,
            currencyCode: resolution.currency,
            updatedAt: new Date(),
          })
          .where(eq(quotes.id, q.id));
        await tx.insert(quoteStatusLog).values({
          quoteId: q.id,
          branchId: q.branchId,
          fromStatus: from,
          toStatus: 'priced',
          actorUserId: scope.userId,
          reason: null,
          metadata: { lineCount: resolution.lines.length },
        });

        // Audit any per-line margin override decisions. Manager-set
        // discretion needs a paper trail the corporate audit log can
        // surface in /corporate/audit.
        for (const ln of resolution.lines) {
          if (ln.marginOverridePct === null) continue;
          await tx.insert(auditLog).values({
            actorUserId: scope.userId,
            targetBranchId: q.branchId,
            action: 'quote.margin_override',
            scopeType: scope.type,
            scopeId: null,
            metadata: {
              quoteId: q.id,
              position: ln.position,
              sku: ln.sku,
              marginOverridePct: ln.marginOverridePct,
              marginOverrideReason: ln.marginOverrideReason,
            },
          });
        }

        const detail = await loadQuoteDetail(tx, q.id, scope);
        return { kind: 'ok' as const, detail };
      });

      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Quote not found' },
        });
      }
      if (outcome.kind === 'supplier_missing') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Supplier not found' },
        });
      }
      if (outcome.kind === 'invalid_transition') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'INVALID_TRANSITION',
            message: `cannot move from ${outcome.from} to ${outcome.to}`,
          },
        });
      }
      if (outcome.kind === 'no_lines') {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'lineItems must be a non-empty array' },
        });
      }
      if (outcome.kind === 'resolve_error') {
        return reply.code(outcome.error.status).send({
          ok: false,
          error: { code: outcome.error.code, message: outcome.error.message },
        });
      }
      return reply.code(200).send({ ok: true, data: outcome.detail });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/quotes/:id/commit
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/quotes/:id/commit',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const parsed = CommitQuoteSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const headerVal = req.headers['idempotency-key'];
      const headerKey = Array.isArray(headerVal) ? headerVal[0] : headerVal;
      const scope = req.scope;

      const outcome = await withScope(db, scope, async (tx) => {
        const qRows = await tx
          .select()
          .from(quotes)
          .where(eq(quotes.id, req.params.id))
          .limit(1);
        const q = qRows[0];
        if (!q) return { kind: 'not_found' as const };
        if (!inScope(scope, q.branchId)) return { kind: 'not_found' as const };
        const from = q.status as QuoteStatus;
        if (!canTransition(from, 'committed')) {
          return { kind: 'invalid_transition' as const, from, to: 'committed' as const };
        }
        const supRows = await tx
          .select()
          .from(suppliers)
          .where(eq(suppliers.id, q.supplierId))
          .limit(1);
        const sup = supRows[0];
        if (!sup) return { kind: 'supplier_missing' as const };
        const provider = bindProvider(registry, sup);

        const lines = await tx
          .select()
          .from(quoteLineItems)
          .where(eq(quoteLineItems.quoteId, q.id))
          .orderBy(quoteLineItems.position);

        // Idempotency precedence: standard HTTP header → request body → quote-id fallback.
        // The header is the canonical form per RFC 8941 + IETF idempotency-key draft;
        // the body field is a legacy/internal escape hatch.
        const idempotencyKey =
          (headerKey && headerKey.length > 0 ? headerKey : undefined) ??
          parsed.data.idempotencyKey ??
          q.id;
        const commitRes = await provider.commitQuote({
          supplierAccountCode: sup.supplierAccountCode,
          externalQuoteId: idempotencyKey,
          requestId: String(req.id),
          items: lines.map((ln) => ({
            sku: ln.supplierSku,
            quantity: Number(ln.quantity),
            options: { unitPriceCents: ln.unitPriceCents },
          })),
          currency: (q.currencyCode as 'CAD' | 'USD') ?? 'CAD',
          notes: q.notes ?? undefined,
        });
        if (!commitRes.ok) {
          return { kind: 'commit_failed' as const, error: commitRes.error };
        }

        const committedAt = new Date();
        await tx
          .update(quotes)
          .set({
            status: 'committed',
            supplierQuoteRef: commitRes.data.supplierQuoteRef,
            supplierQuoteId: commitRes.data.supplierQuoteId,
            committedAt,
            closerUserId: scope.userId,
            validUntil: new Date(commitRes.data.validUntil),
            updatedAt: committedAt,
          })
          .where(eq(quotes.id, q.id));
        await tx.insert(quoteStatusLog).values({
          quoteId: q.id,
          branchId: q.branchId,
          fromStatus: from,
          toStatus: 'committed',
          actorUserId: scope.userId,
          reason: null,
          metadata: { supplierQuoteRef: commitRes.data.supplierQuoteRef },
        });

        if (scope.type === 'branch') {
          await onQuoteCommitted(tx, {
            quoteId: q.id,
            branchId: q.branchId,
            closerUserId: scope.userId,
            totalCents: q.totalCents,
            committedAt,
          });
        }

        const detail = await loadQuoteDetail(tx, q.id, scope);
        return { kind: 'ok' as const, detail };
      });

      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Quote not found' },
        });
      }
      if (outcome.kind === 'supplier_missing') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Supplier not found' },
        });
      }
      if (outcome.kind === 'invalid_transition') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'INVALID_TRANSITION',
            message: `cannot move from ${outcome.from} to ${outcome.to}`,
          },
        });
      }
      if (outcome.kind === 'commit_failed') {
        const e = outcome.error;
        let status = 502;
        if (e.code === 'IDEMPOTENCY_CONFLICT') status = 409;
        else if (e.code === 'INVALID_REQUEST') status = 400;
        else if (e.code === 'UNAUTHORIZED') status = 401;
        else if (e.code === 'NOT_FOUND') status = 404;
        else if (e.code === 'RATE_LIMITED') status = 429;
        return reply.code(status).send({
          ok: false,
          error: { code: e.code, message: e.message },
        });
      }
      return reply.code(200).send({ ok: true, data: outcome.detail });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/quotes/:id/accept
  //
  // Records that the customer has agreed to a committed quote. Allowed for
  // any branch-scoped role (csr / tech / manager) and corporate_admin —
  // the gate explicitly says "recorded by CSR / tech". This is the
  // operator-records-acceptance path; a customer-facing accept link is
  // out-of-scope per TD-SQB-P4.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/quotes/:id/accept',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const parsed = AcceptQuoteSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const scope = req.scope;
      const channel = parsed.data.acknowledgmentChannel ?? 'verbal_phone';
      const notes = parsed.data.notes ?? null;

      const outcome = await withScope(db, scope, async (tx) => {
        const qRows = await tx
          .select()
          .from(quotes)
          .where(eq(quotes.id, req.params.id))
          .limit(1);
        const q = qRows[0];
        if (!q) return { kind: 'not_found' as const };
        if (!inScope(scope, q.branchId)) return { kind: 'not_found' as const };
        const from = q.status as QuoteStatus;
        if (!canTransition(from, 'accepted')) {
          return {
            kind: 'invalid_transition' as const,
            from,
            to: 'accepted' as const,
          };
        }

        const acceptedAt = new Date();
        await tx
          .update(quotes)
          .set({ status: 'accepted', acceptedAt, updatedAt: acceptedAt })
          .where(eq(quotes.id, q.id));
        await tx.insert(quoteStatusLog).values({
          quoteId: q.id,
          branchId: q.branchId,
          fromStatus: from,
          toStatus: 'accepted',
          actorUserId: scope.userId,
          reason: notes,
          metadata: { acknowledgmentChannel: channel },
        });

        const detail = await loadQuoteDetail(tx, q.id, scope);
        return { kind: 'ok' as const, detail };
      });

      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Quote not found' },
        });
      }
      if (outcome.kind === 'invalid_transition') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'INVALID_TRANSITION',
            message: `cannot move from ${outcome.from} to ${outcome.to}`,
          },
        });
      }
      return reply.code(200).send({ ok: true, data: outcome.detail });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/quotes/:id/void
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/quotes/:id/void',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const parsed = VoidQuoteSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const scope = req.scope;
      const reason = parsed.data.reason ?? null;

      // The void path:
      //   1. transition check + status update + log row in one tx
      //   2. write balancing commission ledger rows for committed/accepted
      //   3. best-effort provider.voidQuote() AFTER commit
      // The provider call is intentionally OUTSIDE the transaction so a
      // supplier-side hiccup doesn't roll back the local void state.
      const outcome = await withScope(db, scope, async (tx) => {
        const qRows = await tx
          .select()
          .from(quotes)
          .where(eq(quotes.id, req.params.id))
          .limit(1);
        const q = qRows[0];
        if (!q) return { kind: 'not_found' as const };
        if (!inScope(scope, q.branchId)) return { kind: 'not_found' as const };
        const from = q.status as QuoteStatus;
        if (!canTransition(from, 'void')) {
          return { kind: 'invalid_transition' as const, from, to: 'void' as const };
        }

        const voidedAt = new Date();
        await tx
          .update(quotes)
          .set({ status: 'void', voidedAt, updatedAt: voidedAt })
          .where(eq(quotes.id, q.id));
        await tx.insert(quoteStatusLog).values({
          quoteId: q.id,
          branchId: q.branchId,
          fromStatus: from,
          toStatus: 'void',
          actorUserId: scope.userId,
          reason,
          metadata: {},
        });

        if (from === 'committed' || from === 'accepted') {
          await reverseQuoteCommitted(tx, q.id, reason ?? 'quote_voided');
        }

        const supplierRef = q.supplierQuoteRef;
        const supplierId = q.supplierId;
        const detail = await loadQuoteDetail(tx, q.id, scope);
        return {
          kind: 'ok' as const,
          detail,
          supplierRef,
          supplierId,
        };
      });

      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Quote not found' },
        });
      }
      if (outcome.kind === 'invalid_transition') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'INVALID_TRANSITION',
            message: `cannot move from ${outcome.from} to ${outcome.to}`,
          },
        });
      }

      // Best-effort supplier-side void. Failure here is logged and
      // swallowed — the local void already succeeded; surfacing a 502
      // would make the client think the whole call failed.
      if (outcome.supplierRef) {
        try {
          const supRows = await db
            .select()
            .from(suppliers)
            .where(eq(suppliers.id, outcome.supplierId))
            .limit(1);
          const sup = supRows[0];
          if (sup) {
            const provider = bindProvider(registry, sup);
            if (provider.voidQuote) {
              const res = await provider.voidQuote(outcome.supplierRef);
              if (!res.ok) {
                app.log.warn(
                  { code: res.error.code, message: res.error.message },
                  'supplier voidQuote returned an error; continuing',
                );
              }
            }
          }
        } catch (err) {
          app.log.warn({ err }, 'supplier voidQuote threw; continuing');
        }
      }

      return reply.code(200).send({ ok: true, data: outcome.detail });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/v1/quotes/:id
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/api/v1/quotes/:id',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const scope = req.scope;
      const detail = await withScope(db, scope, (tx) =>
        loadQuoteDetail(tx, req.params.id, scope),
      );
      if (!detail) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Quote not found' },
        });
      }
      return reply.code(200).send({ ok: true, data: detail });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/v1/quotes — list
  // -------------------------------------------------------------------------
  app.get('/api/v1/quotes', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const scope = req.scope;
    const q = req.query as Record<string, string | undefined>;
    const status = q['status'];
    const customerId = q['customerId'];
    const jobId = q['jobId'];
    const branchIdFilter = q['branchId'];

    const rows = await withScope(db, scope, async (tx) => {
      const conditions: unknown[] = [];
      if (scope.type === 'branch') {
        conditions.push(eq(quotes.branchId, scope.branchId));
      } else if (branchIdFilter) {
        // Only corporate may filter by branchId.
        conditions.push(eq(quotes.branchId, branchIdFilter));
      }
      if (status) {
        const allowed: QuoteStatus[] = ['draft', 'priced', 'committed', 'accepted', 'void'];
        if (!allowed.includes(status as QuoteStatus)) {
          return null;
        }
        conditions.push(eq(quotes.status, status as QuoteStatus));
      }
      if (customerId) {
        conditions.push(eq(quotes.customerId, customerId));
      }
      if (jobId) {
        conditions.push(eq(quotes.jobId, jobId));
      }
      const where =
        conditions.length > 0
          ? and(...(conditions as Parameters<typeof and>))
          : sql`true`;
      return tx
        .select()
        .from(quotes)
        .where(where)
        .orderBy(desc(quotes.createdAt))
        .limit(200);
    });

    if (rows === null) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'invalid status filter' },
      });
    }
    return reply.code(200).send({ ok: true, data: { rows } });
  });
}
