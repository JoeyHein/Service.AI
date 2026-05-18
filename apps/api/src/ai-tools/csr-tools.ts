/**
 * Concrete CSR agent tool implementations (TASK-CV-03).
 *
 * Each tool is a function that takes the scoped Drizzle db + a
 * per-call context and returns a `ToolSet` record compatible
 * with `@service-ai/ai`'s runAgentLoop. The tools themselves
 * enforce tenant scope — every DB query is gated on
 * `ctx.branchId`, so a hallucinated cross-tenant id returns
 * `INVALID_TARGET` from the tool's own POV and the model learns
 * from the tool_result.
 *
 * The tools must NOT throw. Failures are returned as
 * `{ ok: false, error: { code, message } }` so the agent loop
 * can feed them back as tool_results and keep going.
 */

import { and, eq, gte, ilike, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  aiMessages,
  auditLog,
  corporate,
  customers,
  jobs,
  marginOverrides,
  memberships,
  quotes,
  quoteLineItems,
  quoteStatusLog,
  users,
  type ScopedTx,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import type { Tool, ToolResult } from '@service-ai/ai';
import type { SupplierProvider } from '@service-ai/suppliers';
import { resolveSellingPrice, type MarginPolicy } from '../margin-engine.js';
import { onQuoteCommitted } from '../commission-engine.js';

type Drizzle = NodePgDatabase<typeof schema>;

export interface CsrToolDeps {
  db: Drizzle;
  /** Transactional executor that wraps withScope. When testing,
   *  passed as a function that just runs the callback directly
   *  against the drizzle handle (since tests control RLS). */
  runScoped: <T>(fn: (tx: ScopedTx) => Promise<T>) => Promise<T>;
  /** Conversation row id so logCallSummary can attach. */
  conversationId: string;
  /** Set by the loop after each tool call so the next tool knows
   *  the resolved customer. In a fully-stateless world the agent
   *  would carry this in the transcript, but surfacing it here
   *  keeps tools independent of transcript parsing. */
  state: {
    customerId?: string;
    /** Set by `quoteConfigurator` so `commitQuote` knows which row
     *  to ship. Cleared after a successful commit. */
    currentQuoteId?: string;
  };
  /**
   * Optional supplier wiring for the quoteConfigurator + commitQuote
   * tools (SQB-10). When absent, those tools surface a
   * `SUPPLIER_NOT_CONFIGURED` error rather than throwing — the agent
   * can transfer the call to a human or skip the quote step.
   */
  supplier?: {
    /** suppliers.id row this branch quotes against. */
    supplierId: string;
    /** Live SupplierProvider — production wires `BcAiAgentProvider`,
     *  tests wire `MockSupplierProvider`. */
    provider: SupplierProvider;
    /** What the BC AI Agent should treat as the supplier_account_code
     *  for this branch (usually the BC customer number). */
    supplierAccountCode: string;
  };
}

function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}
function err(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message } };
}

function phoneMatch(a: string): string {
  return a.replace(/[^0-9+]/g, '');
}

// ---------------------------------------------------------------------------
// lookupCustomer
// ---------------------------------------------------------------------------

export function lookupCustomerTool(deps: CsrToolDeps): Tool<{
  phone?: string;
  name?: string;
}> {
  return {
    schema: {
      name: 'lookupCustomer',
      description:
        'Search for an existing customer by phone number (preferred) or name. Returns the first match.',
      inputSchema: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'E.164 or unformatted phone' },
          name: { type: 'string' },
        },
      },
    },
    async execute(input, ctx) {
      if (!input.phone && !input.name) {
        return err('INVALID_INPUT', 'Provide phone or name');
      }
      const result = await deps.runScoped(async (tx) => {
        const conditions = [
          eq(customers.branchId, ctx.branchId),
          isNull(customers.deletedAt),
        ];
        if (input.phone) {
          conditions.push(eq(customers.phone, phoneMatch(input.phone)));
        }
        if (input.name) {
          conditions.push(ilike(customers.name, `%${input.name}%`));
        }
        const rows = await tx
          .select()
          .from(customers)
          .where(and(...conditions))
          .limit(1);
        return rows[0] ?? null;
      });
      if (!result) return err('NOT_FOUND', 'No matching customer');
      deps.state.customerId = result.id;
      return ok({
        customerId: result.id,
        name: result.name,
        phone: result.phone,
        addressLine1: result.addressLine1,
        city: result.city,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// createCustomer
// ---------------------------------------------------------------------------

export function createCustomerTool(deps: CsrToolDeps): Tool<{
  name: string;
  phone?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
}> {
  return {
    schema: {
      name: 'createCustomer',
      description:
        'Create a new customer record. Use only after lookupCustomer returns NOT_FOUND.',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
          addressLine1: { type: 'string' },
          city: { type: 'string' },
          state: { type: 'string' },
        },
      },
    },
    async execute(input, ctx) {
      if (!input.name || input.name.trim().length === 0) {
        return err('INVALID_INPUT', 'Name is required');
      }
      const created = await deps.runScoped(async (tx) => {
        const rows = await tx
          .insert(customers)
          .values({
            branchId: ctx.branchId,
            name: input.name,
            phone: input.phone ? phoneMatch(input.phone) : null,
            addressLine1: input.addressLine1 ?? null,
            city: input.city ?? null,
            state: input.state ?? null,
          })
          .returning();
        return rows[0]!;
      });
      deps.state.customerId = created.id;
      return ok({ customerId: created.id, name: created.name });
    },
  };
}

// ---------------------------------------------------------------------------
// proposeTimeSlots
// ---------------------------------------------------------------------------

export function proposeTimeSlotsTool(_deps: CsrToolDeps): Tool<{
  windowStart?: string;
  windowEnd?: string;
  durationMinutes?: number;
}> {
  return {
    schema: {
      name: 'proposeTimeSlots',
      description:
        'Return 3 candidate appointment slots spread across today + tomorrow. Use ISO-8601 windowStart and windowEnd; both optional (defaults to the next 24h).',
      inputSchema: {
        type: 'object',
        properties: {
          windowStart: { type: 'string' },
          windowEnd: { type: 'string' },
          durationMinutes: { type: 'number', minimum: 15, maximum: 480 },
        },
      },
    },
    async execute(input, ctx) {
      const now = new Date();
      const start = input.windowStart ? new Date(input.windowStart) : now;
      const duration = Math.max(15, Math.min(input.durationMinutes ?? 120, 480));
      // Greedy strategy: three 2-hour slots at 9am, 12pm, 3pm in the
      // caller's local reference frame. Phase 9 keeps it simple;
      // phase 10 (AI dispatcher) plugs in live tech calendars.
      const base = new Date(start);
      base.setHours(9, 0, 0, 0);
      if (base < start) base.setDate(base.getDate() + 1);
      const slots = [0, 3, 6].map((offsetHours) => {
        const s = new Date(base);
        s.setHours(s.getHours() + offsetHours);
        const e = new Date(s);
        e.setMinutes(e.getMinutes() + duration);
        return { start: s.toISOString(), end: e.toISOString() };
      });
      // The branch_id guard here is strictly belt-and-suspenders;
      // slot proposal is read-only math.
      void ctx.branchId;
      return ok({ slots });
    },
  };
}

// ---------------------------------------------------------------------------
// bookJob
// ---------------------------------------------------------------------------

export function bookJobTool(deps: CsrToolDeps): Tool<{
  customerId?: string;
  title: string;
  description?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  assignedTechUserId?: string;
}> {
  return {
    schema: {
      name: 'bookJob',
      description:
        'Create and schedule a job for a customer. Use the customerId from lookupCustomer or createCustomer; omit it to use the most recently resolved customer.',
      inputSchema: {
        type: 'object',
        required: ['title'],
        properties: {
          customerId: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          scheduledStart: { type: 'string' },
          scheduledEnd: { type: 'string' },
          assignedTechUserId: { type: 'string' },
        },
      },
    },
    async execute(input, ctx) {
      const customerId = input.customerId ?? deps.state.customerId;
      if (!customerId) {
        return err('INVALID_INPUT', 'No customerId — call lookupCustomer/createCustomer first');
      }
      const result = await deps.runScoped(async (tx) => {
        const custRows = await tx
          .select()
          .from(customers)
          .where(
            and(
              eq(customers.id, customerId),
              eq(customers.branchId, ctx.branchId),
              isNull(customers.deletedAt),
            ),
          );
        if (!custRows[0]) return null;

        if (input.assignedTechUserId) {
          const tech = await tx
            .select()
            .from(memberships)
            .where(
              and(
                eq(memberships.userId, input.assignedTechUserId),
                eq(memberships.scopeType, 'branch'),
                eq(memberships.scopeId, ctx.branchId),
                eq(memberships.role, 'tech'),
                isNull(memberships.deletedAt),
              ),
            );
          if (!tech[0]) return 'bad_tech' as const;
        }

        const now = new Date();
        const scheduledStart = input.scheduledStart
          ? new Date(input.scheduledStart)
          : null;
        const scheduledEnd = input.scheduledEnd
          ? new Date(input.scheduledEnd)
          : null;

        const inserted = await tx
          .insert(jobs)
          .values({
            branchId: ctx.branchId,
            customerId,
            title: input.title,
            description: input.description ?? null,
            status: scheduledStart ? 'scheduled' : 'unassigned',
            scheduledStart,
            scheduledEnd,
            assignedTechUserId: input.assignedTechUserId ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        return { kind: 'ok' as const, job: inserted[0]! };
      });

      if (result === null) {
        return err('INVALID_TARGET', 'Customer not found in this branch');
      }
      if (result === 'bad_tech') {
        return err('INVALID_TARGET', 'Tech is not assigned to this branch');
      }
      return ok({
        jobId: result.job.id,
        title: result.job.title,
        status: result.job.status,
        scheduledStart: result.job.scheduledStart,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// transferToHuman
// ---------------------------------------------------------------------------

export function transferToHumanTool(deps: CsrToolDeps): Tool<{
  reason: string;
  priority?: 'low' | 'normal' | 'high';
}> {
  return {
    schema: {
      name: 'transferToHuman',
      description:
        'Hand off to a human dispatcher. Use when the caller asks for a human, is incoherent, or you are uncertain.',
      inputSchema: {
        type: 'object',
        required: ['reason'],
        properties: {
          reason: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        },
      },
    },
    async execute(input, ctx) {
      await deps.runScoped(async (tx) => {
        await tx.insert(aiMessages).values({
          conversationId: deps.conversationId,
          branchId: ctx.branchId,
          role: 'tool',
          content: { transferredTo: 'human' },
          toolName: 'transferToHuman',
          toolInput: input,
          toolOutput: { transferred: true },
        });
      });
      return ok({
        transferred: true,
        message:
          'Thanks — I\'m connecting you with a dispatcher now.',
        priority: input.priority ?? 'normal',
        reason: input.reason,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// logCallSummary
// ---------------------------------------------------------------------------

export function logCallSummaryTool(deps: CsrToolDeps): Tool<{
  summary: string;
  intent: string;
  outcome: 'booked' | 'transferred' | 'abandoned' | 'none';
}> {
  return {
    schema: {
      name: 'logCallSummary',
      description:
        'Write a one-paragraph summary of the call. Always call this last.',
      inputSchema: {
        type: 'object',
        required: ['summary', 'intent', 'outcome'],
        properties: {
          summary: { type: 'string' },
          intent: { type: 'string' },
          outcome: {
            type: 'string',
            enum: ['booked', 'transferred', 'abandoned', 'none'],
          },
        },
      },
    },
    async execute(input, ctx) {
      await deps.runScoped(async (tx) => {
        await tx.insert(aiMessages).values({
          conversationId: deps.conversationId,
          branchId: ctx.branchId,
          role: 'tool',
          content: { summary: input.summary },
          toolName: 'logCallSummary',
          toolInput: input,
          toolOutput: { logged: true },
        });
      });
      return ok({ logged: true, outcome: input.outcome });
    },
  };
}

// ---------------------------------------------------------------------------
// Tool set builder
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// quoteConfigurator  (SQB-10)
//
// On every call: (re)prices the current quote against the wired
// supplier and stores the lines + totals on the row. Creates the
// draft on first call. The AI can iterate freely — keep calling
// until the customer agrees on the spec, then call commitQuote.
// ---------------------------------------------------------------------------

interface ConfiguratorLineIn {
  sku: string;
  quantity: number;
}

async function loadMarginPolicy(
  tx: ScopedTx,
  categories: Set<string>,
): Promise<{ policy: MarginPolicy; byCategory: Map<string, number> }> {
  const corpRows = await tx
    .select({
      defaultPct: corporate.defaultMarginPct,
      minPct: corporate.minMarginPct,
      maxPct: corporate.maxMarginPct,
    })
    .from(corporate)
    .limit(1);
  const policy: MarginPolicy = {
    defaultPct: Number(corpRows[0]?.defaultPct ?? 60),
    minPct: Number(corpRows[0]?.minPct ?? 20),
    maxPct: Number(corpRows[0]?.maxPct ?? 200),
  };
  const byCategory = new Map<string, number>();
  if (categories.size > 0) {
    const catList = Array.from(categories);
    const overrideRows = await tx
      .select({
        itemCategory: marginOverrides.itemCategory,
        marginPct: marginOverrides.marginPct,
      })
      .from(marginOverrides)
      .where(sql`${marginOverrides.itemCategory} IN ${catList}`);
    for (const r of overrideRows) {
      byCategory.set(r.itemCategory, Number(r.marginPct));
    }
  }
  return { policy, byCategory };
}

export function quoteConfiguratorTool(deps: CsrToolDeps): Tool<{
  items: ConfiguratorLineIn[];
  customerId?: string;
}> {
  return {
    schema: {
      name: 'quoteConfigurator',
      description:
        'Build or update a draft quote for the resolved customer. Pass the SKUs + quantities the caller wants. Idempotent — call again to update the lines. Returns priced lines + the running total.',
      inputSchema: {
        type: 'object',
        required: ['items'],
        properties: {
          customerId: { type: 'string' },
          items: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['sku', 'quantity'],
              properties: {
                sku: { type: 'string' },
                quantity: { type: 'number' },
              },
            },
          },
        },
      },
    },
    async execute(input, ctx) {
      if (!deps.supplier) {
        return err(
          'SUPPLIER_NOT_CONFIGURED',
          'No supplier is wired for this branch — transfer the call to a human to take the quote manually.',
        );
      }
      const customerId = input.customerId ?? deps.state.customerId;
      if (!customerId) {
        return err(
          'INVALID_INPUT',
          'No customerId — call lookupCustomer/createCustomer first.',
        );
      }
      // Sanity-check the items shape — model hallucinations sometimes
      // hand back qty: 0 or non-positive numbers.
      const safeItems = input.items.filter(
        (i) => i.sku && Number.isFinite(i.quantity) && i.quantity > 0,
      );
      if (safeItems.length === 0) {
        return err('INVALID_INPUT', 'items must include at least one positive-qty line');
      }

      // 1. Pull supplier-side prices in one batch call.
      const priced = await deps.supplier.provider.priceItems({
        supplierAccountCode: deps.supplier.supplierAccountCode,
        items: safeItems.map((i) => ({ sku: i.sku, quantity: i.quantity })),
        currency: 'CAD',
      });
      if (!priced.ok) {
        return err(
          priced.error.code,
          priced.error.message ?? 'Supplier pricing failed',
        );
      }

      // 2. Open / reuse the draft quote.
      const result = await deps.runScoped(async (tx) => {
        const custRows = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(
            and(
              eq(customers.id, customerId),
              eq(customers.branchId, ctx.branchId),
              isNull(customers.deletedAt),
            ),
          );
        if (!custRows[0]) return { kind: 'no_customer' as const };

        let quoteId = deps.state.currentQuoteId ?? null;
        if (quoteId) {
          // Confirm the existing row still belongs to this scope +
          // is still editable.
          const existing = await tx
            .select({ id: quotes.id, status: quotes.status })
            .from(quotes)
            .where(eq(quotes.id, quoteId));
          if (!existing[0] || existing[0].status === 'void' || existing[0].status === 'accepted') {
            quoteId = null; // start a fresh draft
          }
        }
        if (!quoteId) {
          const inserted = await tx
            .insert(quotes)
            .values({
              branchId: ctx.branchId,
              customerId,
              supplierId: deps.supplier!.supplierId,
              status: 'draft',
            })
            .returning({ id: quotes.id });
          quoteId = inserted[0]!.id;
        }

        // 3. Apply the margin engine to every priced line.
        const categories = new Set<string>();
        for (const line of priced.data.items) {
          if (line.itemCategory) categories.add(line.itemCategory);
        }
        const { policy, byCategory } = await loadMarginPolicy(tx, categories);

        const resolved: Array<{
          sku: string;
          description: string;
          itemCategory: string | null;
          quantity: number;
          unitCostCents: number;
          unitPriceCents: number;
          lineTotalCents: number;
          marginPct: number;
          marginSource: 'line_override' | 'category_override' | 'corporate_default';
        }> = [];
        for (const line of priced.data.items) {
          const categoryPct = line.itemCategory
            ? byCategory.get(line.itemCategory) ?? null
            : null;
          const r = resolveSellingPrice({
            unitCostCents: line.unitCostCents,
            itemCategory: line.itemCategory,
            categoryMarginPct: categoryPct,
            policy,
          });
          if (!r.ok) {
            return { kind: 'margin_out_of_bounds' as const, message: r.message };
          }
          resolved.push({
            sku: line.sku,
            description: line.description,
            itemCategory: line.itemCategory,
            quantity: line.quantity,
            unitCostCents: line.unitCostCents,
            unitPriceCents: r.unitPriceCents,
            lineTotalCents: r.unitPriceCents * line.quantity,
            marginPct: r.marginPct,
            marginSource: r.marginSource,
          });
        }

        // 4. Replace lines + update totals.
        await tx.delete(quoteLineItems).where(eq(quoteLineItems.quoteId, quoteId));
        const subtotal = resolved.reduce((s, l) => s + l.lineTotalCents, 0);
        for (let i = 0; i < resolved.length; i += 1) {
          const l = resolved[i]!;
          await tx.insert(quoteLineItems).values({
            quoteId,
            branchId: ctx.branchId,
            position: i,
            supplierSku: l.sku,
            description: l.description,
            itemCategory: l.itemCategory,
            quantity: String(l.quantity),
            unitPriceCents: l.unitPriceCents,
            lineTotalCents: l.lineTotalCents,
            supplierUnitCostCents: l.unitCostCents,
            appliedMarginPct: String(l.marginPct),
            appliedMarginSource: l.marginSource,
          });
        }
        await tx
          .update(quotes)
          .set({
            subtotalCents: subtotal,
            taxCents: 0,
            totalCents: subtotal,
            currencyCode: 'CAD',
            status: 'priced',
            updatedAt: new Date(),
          })
          .where(eq(quotes.id, quoteId));
        await tx.insert(quoteStatusLog).values({
          quoteId,
          branchId: ctx.branchId,
          fromStatus: 'draft',
          toStatus: 'priced',
          actorUserId: ctx.userId,
          reason: 'csr_voice_configurator',
        });
        return {
          kind: 'ok' as const,
          quoteId,
          subtotal,
          resolved,
        };
      });

      if (result.kind === 'no_customer') {
        return err('INVALID_TARGET', 'Customer not found in this branch');
      }
      if (result.kind === 'margin_out_of_bounds') {
        return err('MARGIN_OUT_OF_BOUNDS', result.message);
      }

      deps.state.currentQuoteId = result.quoteId;
      return ok({
        quoteId: result.quoteId,
        items: result.resolved.map((l) => ({
          sku: l.sku,
          description: l.description,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          lineTotalCents: l.lineTotalCents,
        })),
        subtotalCents: result.subtotal,
        totalCents: result.subtotal,
        currency: 'CAD',
      });
    },
  };
}

// ---------------------------------------------------------------------------
// commitQuote  (SQB-10)
//
// Confidence-gated tool. Sends the configured quote to the supplier
// and returns the SQ-XXXXXX ref. Writes an audit_log row capturing the
// confidence and the resulting supplier ref so the per-call summary
// can attribute the commit. Commission credit is written via
// `onQuoteCommitted` (CHR-05) so the closer's ledger updates the
// instant the supplier accepts.
// ---------------------------------------------------------------------------

export function commitQuoteTool(deps: CsrToolDeps): Tool<{
  /** Optional override; falls back to state.currentQuoteId. */
  quoteId?: string;
  /** Caller's confidence score 0..1 from the agent loop. */
  confidence?: number;
}> {
  return {
    schema: {
      name: 'commitQuote',
      description:
        'Send the current draft quote to the supplier. Only call after the customer has confirmed the line items and total. Returns the supplier quote reference.',
      inputSchema: {
        type: 'object',
        properties: {
          quoteId: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    async execute(input, ctx) {
      if (!deps.supplier) {
        return err(
          'SUPPLIER_NOT_CONFIGURED',
          'No supplier is wired for this branch.',
        );
      }
      const quoteId = input.quoteId ?? deps.state.currentQuoteId;
      if (!quoteId) {
        return err('INVALID_INPUT', 'No active quote — call quoteConfigurator first.');
      }
      const confidence = input.confidence ?? 0;

      // AI guardrail floors per CLAUDE.md "AI guardrail defaults" + the SQB
      // gate (csr.commitQuote: confidence ≥ 0.90, dollar cap $5,000). These
      // are tool-local because the agent loop's single `confidenceThreshold`
      // (0.80 default) is not strict enough for a path that creates a real
      // BC sales quote and writes a commission row. Enforced here so a
      // voice agent reporting 0.85 (or worse: nothing) cannot commit.
      const COMMIT_QUOTE_CONFIDENCE_FLOOR = 0.9;
      const COMMIT_QUOTE_DOLLAR_CAP_CENTS = 500_000; // $5,000 USD/CAD
      if (confidence < COMMIT_QUOTE_CONFIDENCE_FLOOR) {
        return err(
          'CONFIDENCE_TOO_LOW',
          `commitQuote requires confidence ≥ ${COMMIT_QUOTE_CONFIDENCE_FLOOR}; got ${confidence}. Ask the customer to confirm out loud, then retry.`,
        );
      }

      // Read the current quote + lines outside the supplier call so we
      // know what we're shipping.
      const snapshot = await deps.runScoped(async (tx) => {
        const qRows = await tx
          .select({
            id: quotes.id,
            status: quotes.status,
            branchId: quotes.branchId,
            supplierId: quotes.supplierId,
            totalCents: quotes.totalCents,
          })
          .from(quotes)
          .where(eq(quotes.id, quoteId));
        const q = qRows[0];
        if (!q || q.branchId !== ctx.branchId) return null;
        const items = await tx
          .select({
            sku: quoteLineItems.supplierSku,
            quantity: quoteLineItems.quantity,
            unitPriceCents: quoteLineItems.unitPriceCents,
            description: quoteLineItems.description,
          })
          .from(quoteLineItems)
          .where(eq(quoteLineItems.quoteId, quoteId));
        return { q, items };
      });
      if (!snapshot) return err('INVALID_TARGET', 'Quote not found in this branch');
      if (snapshot.q.status !== 'priced') {
        return err(
          'INVALID_TRANSITION',
          `Quote status is ${snapshot.q.status}; must be priced to commit`,
        );
      }
      if (snapshot.q.totalCents > COMMIT_QUOTE_DOLLAR_CAP_CENTS) {
        return err(
          'OVER_DOLLAR_CAP',
          `commitQuote is capped at $${COMMIT_QUOTE_DOLLAR_CAP_CENTS / 100} via AI; quote total is $${(snapshot.q.totalCents / 100).toFixed(2)}. Hand off to a manager to commit.`,
        );
      }

      // Talk to the supplier.
      const commit = await deps.supplier.provider.commitQuote({
        supplierAccountCode: deps.supplier.supplierAccountCode,
        externalQuoteId: quoteId,
        items: snapshot.items.map((l) => ({
          sku: l.sku,
          quantity: Number(l.quantity),
          options: {
            unitPriceCents: l.unitPriceCents,
            description: l.description ?? undefined,
          },
        })),
        currency: 'CAD',
      });
      if (!commit.ok) {
        return err(commit.error.code, commit.error.message);
      }

      // commitQuote credits commission to a user. AI calls run with
      // ctx.userId nullable in principle (some agent loops carry no
      // userId), but for the CSR voice path the WS server always
      // resolves a user. Refuse rather than try to credit a phantom.
      if (!ctx.userId) {
        return err(
          'INVALID_INPUT',
          'commitQuote requires an authenticated actor; the voice WS did not supply one',
        );
      }
      const actorUserId: string = ctx.userId;

      // Stamp + credit. Single tx so a commission write failure rolls
      // back the status change.
      await deps.runScoped(async (tx) => {
        const now = new Date();
        await tx
          .update(quotes)
          .set({
            status: 'committed',
            supplierQuoteRef: commit.data.supplierQuoteRef,
            supplierQuoteId: commit.data.supplierQuoteId,
            committedAt: now,
            closerUserId: actorUserId,
            updatedAt: now,
          })
          .where(eq(quotes.id, quoteId));
        await tx.insert(quoteStatusLog).values({
          quoteId,
          branchId: ctx.branchId,
          fromStatus: 'priced',
          toStatus: 'committed',
          actorUserId,
          reason: 'csr_voice_commit',
        });
        await onQuoteCommitted(tx, {
          quoteId,
          branchId: ctx.branchId,
          closerUserId: actorUserId,
          totalCents: snapshot.q.totalCents,
          committedAt: now,
        });
        // Audit row capturing the AI confidence at commit time so
        // post-call review can spot low-confidence commits.
        // NOTE: the gate doc referred to `ai_actions` but that table
        // does not exist; we use `audit_log` with a dedicated
        // action verb. Flagged for a follow-up if a per-action
        // table becomes useful (e.g., for fine-tune feedback).
        await tx.insert(auditLog).values({
          actorUserId,
          targetBranchId: ctx.branchId,
          action: 'ai.csr.commitQuote',
          scopeType: 'branch',
          scopeId: ctx.branchId,
          metadata: {
            conversationId: deps.conversationId,
            quoteId,
            supplierQuoteRef: commit.data.supplierQuoteRef,
            confidence,
            totalCents: snapshot.q.totalCents,
          } as Record<string, unknown>,
        });
      });

      // Clear the per-conversation pointer so a follow-up
      // quoteConfigurator call opens a fresh draft.
      deps.state.currentQuoteId = undefined;

      return ok({
        supplierQuoteRef: commit.data.supplierQuoteRef,
        supplierQuoteId: commit.data.supplierQuoteId,
        totalCents: snapshot.q.totalCents,
        validUntil: commit.data.validUntil,
        currency: commit.data.currency,
      });
    },
  };
}

// ---------------------------------------------------------------------------

export function buildCsrToolSet(deps: CsrToolDeps): Record<string, Tool> {
  return {
    lookupCustomer: lookupCustomerTool(deps),
    createCustomer: createCustomerTool(deps),
    proposeTimeSlots: proposeTimeSlotsTool(deps),
    bookJob: bookJobTool(deps),
    quoteConfigurator: quoteConfiguratorTool(deps),
    commitQuote: commitQuoteTool(deps),
    transferToHuman: transferToHumanTool(deps),
    logCallSummary: logCallSummaryTool(deps),
  };
}

/** Tool names that are gated on confidence at the loop level. */
export const CSR_GATED_TOOLS = ['bookJob', 'createCustomer', 'commitQuote'];

// Unused-import smoother for the side-effect imports so eslint
// doesn't flag gte/or when the engine grows more rules later.
void gte;
void or;
void users;
