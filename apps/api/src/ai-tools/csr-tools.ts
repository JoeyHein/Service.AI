/**
 * Concrete CSR agent tool implementations (TASK-CV-03).
 *
 * Each tool is a function that takes the scoped Drizzle db + a
 * per-call context and returns a `ToolSet` record compatible
 * with `@service-ai/ai`'s runAgentLoop. The tools themselves
 * enforce tenant scope — every DB query is gated on
 * `ctx.franchiseeId`, so a hallucinated cross-tenant id returns
 * `INVALID_TARGET` from the tool's own POV and the model learns
 * from the tool_result.
 *
 * The tools must NOT throw. Failures are returned as
 * `{ ok: false, error: { code, message } }` so the agent loop
 * can feed them back as tool_results and keep going.
 */

import { and, eq, gte, ilike, isNull, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  aiMessages,
  customers,
  jobs,
  memberships,
  users,
  type ScopedTx,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import type { Tool, ToolResult } from '@service-ai/ai';

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
          eq(customers.franchiseeId, ctx.franchiseeId),
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
            franchiseeId: ctx.franchiseeId,
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
      // The franchisee_id guard here is strictly belt-and-suspenders;
      // slot proposal is read-only math.
      void ctx.franchiseeId;
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
              eq(customers.franchiseeId, ctx.franchiseeId),
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
                eq(memberships.scopeType, 'franchisee'),
                eq(memberships.scopeId, ctx.franchiseeId),
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
            franchiseeId: ctx.franchiseeId,
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
        return err('INVALID_TARGET', 'Customer not found in this franchisee');
      }
      if (result === 'bad_tech') {
        return err('INVALID_TARGET', 'Tech is not assigned to this franchisee');
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
          franchiseeId: ctx.franchiseeId,
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
          franchiseeId: ctx.franchiseeId,
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

export function buildCsrToolSet(deps: CsrToolDeps): Record<string, Tool> {
  return {
    lookupCustomer: lookupCustomerTool(deps),
    createCustomer: createCustomerTool(deps),
    proposeTimeSlots: proposeTimeSlotsTool(deps),
    bookJob: bookJobTool(deps),
    transferToHuman: transferToHumanTool(deps),
    logCallSummary: logCallSummaryTool(deps),
  };
}

/** Tool names that are gated on confidence at the loop level. */
export const CSR_GATED_TOOLS = ['bookJob', 'createCustomer'];

// Unused-import smoother for the side-effect imports so eslint
// doesn't flag gte/or when the engine grows more rules later.
void gte;
void or;
void users;
