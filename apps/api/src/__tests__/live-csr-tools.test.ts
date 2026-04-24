/**
 * Live Postgres tests for the CSR agent tool suite (TASK-CV-03).
 *
 * Each tool runs against a seeded DB inside a stubbed RLS scope
 * (the `runScoped` helper uses withScope to set the GUCs). The
 * tests assert both the happy path and cross-tenant boundary.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import {
  aiConversations,
  withScope,
  type RequestScope,
  type ScopedTx,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import { runReset, runSeed } from '../seed/index.js';
import {
  buildCsrToolSet,
  type CsrToolDeps,
} from '../ai-tools/csr-tools.js';
import type { ToolContext } from '@service-ai/ai';

const { Pool } = pkg;
const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let ids: { denverId: string; austinId: string };
let conversationId: string;
let ctx: ToolContext;

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await p.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await p.end();
  }
}

function makeDeps(scope: RequestScope, convoId: string): CsrToolDeps {
  return {
    db,
    conversationId: convoId,
    state: {},
    async runScoped<T>(fn: (tx: ScopedTx) => Promise<T>) {
      return withScope(db, scope, fn);
    },
  };
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await runReset(pool);
  const seed = await runSeed(pool);
  ids = {
    denverId: seed.franchisees.find((f) => f.slug === 'denver')!.id,
    austinId: seed.franchisees.find((f) => f.slug === 'austin')!.id,
  };
  db = drizzle(pool, { schema });
  // Seed an ai_conversations row so tools that write messages
  // have a parent to attach to.
  const scope: RequestScope = {
    type: 'franchisee',
    userId: 'system-bot',
    role: 'csr',
    franchisorId: seed.franchisorId,
    franchiseeId: ids.denverId,
  };
  conversationId = await withScope(db, scope, async (tx) => {
    const rows = await tx
      .insert(aiConversations)
      .values({
        franchiseeId: ids.denverId,
        capability: 'csr.voice',
      })
      .returning();
    return rows[0]!.id;
  });
  ctx = {
    franchiseeId: ids.denverId,
    userId: null,
    guardrails: {
      confidenceThreshold: 0.8,
      undoWindowSeconds: 900,
      transferOnLowConfidence: true,
    },
    invocation: { confidence: 1 },
  };
}, 60_000);

afterAll(async () => {
  if (pool) await pool.end();
});

beforeEach((testCtx) => {
  if (!reachable) testCtx.skip();
});

function denverScope(): RequestScope {
  return {
    type: 'franchisee',
    userId: 'system-bot',
    role: 'csr',
    franchisorId: '00000000-0000-0000-0000-000000000000', // not actually checked in tool scope
    franchiseeId: ids.denverId,
  };
}

describe('CV-03 / lookupCustomer', () => {
  it('NOT_FOUND when no customer matches', async () => {
    const tools = buildCsrToolSet(makeDeps(denverScope(), conversationId));
    const res = await tools.lookupCustomer!.execute(
      { phone: '+15555559999' },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('NOT_FOUND');
  });

  it('requires at least phone or name', async () => {
    const tools = buildCsrToolSet(makeDeps(denverScope(), conversationId));
    const res = await tools.lookupCustomer!.execute({}, ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('INVALID_INPUT');
  });
});

describe('CV-03 / createCustomer', () => {
  it('creates a franchisee-scoped customer and echoes the id', async () => {
    const deps = makeDeps(denverScope(), conversationId);
    const tools = buildCsrToolSet(deps);
    const res = await tools.createCustomer!.execute(
      { name: 'Jane Doe', phone: '(555) 111-2222', city: 'Denver' },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(deps.state.customerId).toBeTruthy();
    expect(
      (res.data as { customerId: string; name: string }).name,
    ).toBe('Jane Doe');
  });

  it('empty name → INVALID_INPUT', async () => {
    const tools = buildCsrToolSet(makeDeps(denverScope(), conversationId));
    const res = await tools.createCustomer!.execute({ name: '' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('INVALID_INPUT');
  });
});

describe('CV-03 / proposeTimeSlots', () => {
  it('returns 3 slots', async () => {
    const tools = buildCsrToolSet(makeDeps(denverScope(), conversationId));
    const res = await tools.proposeTimeSlots!.execute({}, ctx);
    expect(res.ok).toBe(true);
    const slots = (res.data as { slots: Array<{ start: string; end: string }> }).slots;
    expect(slots).toHaveLength(3);
    // Slots should be ISO strings.
    expect(Date.parse(slots[0]!.start)).not.toBeNaN();
  });
});

describe('CV-03 / bookJob', () => {
  it('books a job for the resolved customer', async () => {
    const deps = makeDeps(denverScope(), conversationId);
    const tools = buildCsrToolSet(deps);
    await tools.createCustomer!.execute({ name: 'Book Me' }, ctx);
    const res = await tools.bookJob!.execute(
      { title: 'Fix spring', scheduledStart: new Date(Date.now() + 3600_000).toISOString() },
      ctx,
    );
    expect(res.ok).toBe(true);
    const data = res.data as { jobId: string; status: string };
    expect(data.status).toBe('scheduled');
    // Verify the row is visible within scope.
    const rows = await withScope(db, denverScope(), (tx) =>
      tx.select().from(schema.jobs).where(eq(schema.jobs.id, data.jobId)),
    );
    expect(rows[0]?.franchiseeId).toBe(ids.denverId);
  });

  it('refuses with INVALID_INPUT when no customerId resolved', async () => {
    const tools = buildCsrToolSet(makeDeps(denverScope(), conversationId));
    const res = await tools.bookJob!.execute({ title: 'orphan' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('INVALID_INPUT');
  });

  it('cross-tenant customerId → INVALID_TARGET', async () => {
    // Insert a customer into Austin directly, then try to book it as Denver.
    const austinScope: RequestScope = {
      type: 'franchisee',
      userId: 'system-bot',
      role: 'csr',
      franchisorId: '00000000-0000-0000-0000-000000000000',
      franchiseeId: ids.austinId,
    };
    const austinCustomerId = await withScope(db, austinScope, async (tx) => {
      const rows = await tx
        .insert(schema.customers)
        .values({ franchiseeId: ids.austinId, name: 'Austin C' })
        .returning();
      return rows[0]!.id;
    });
    const tools = buildCsrToolSet(makeDeps(denverScope(), conversationId));
    const res = await tools.bookJob!.execute(
      { customerId: austinCustomerId, title: 'hack' },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('INVALID_TARGET');
  });

  it('cross-tenant techUserId → INVALID_TARGET', async () => {
    const deps = makeDeps(denverScope(), conversationId);
    const tools = buildCsrToolSet(deps);
    await tools.createCustomer!.execute({ name: 'Any' }, ctx);
    const res = await tools.bookJob!.execute(
      {
        title: 'hack tech',
        assignedTechUserId: '00000000-0000-0000-0000-000000000000',
      },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('INVALID_TARGET');
  });
});

describe('CV-03 / transferToHuman + logCallSummary', () => {
  it('transfer records a tool row and returns transferred=true', async () => {
    const tools = buildCsrToolSet(makeDeps(denverScope(), conversationId));
    const res = await tools.transferToHuman!.execute(
      { reason: 'caller angry', priority: 'high' },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect((res.data as { transferred: boolean }).transferred).toBe(true);
    const rows = await withScope(db, denverScope(), (tx) =>
      tx
        .select()
        .from(schema.aiMessages)
        .where(eq(schema.aiMessages.conversationId, conversationId)),
    );
    expect(rows.some((r) => r.toolName === 'transferToHuman')).toBe(true);
  });

  it('logCallSummary writes the summary row', async () => {
    const tools = buildCsrToolSet(makeDeps(denverScope(), conversationId));
    const res = await tools.logCallSummary!.execute(
      {
        summary: 'Booked a spring repair for Jane Doe tomorrow at 9am.',
        intent: 'book_repair',
        outcome: 'booked',
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    const rows = await withScope(db, denverScope(), (tx) =>
      tx
        .select()
        .from(schema.aiMessages)
        .where(eq(schema.aiMessages.conversationId, conversationId)),
    );
    expect(rows.some((r) => r.toolName === 'logCallSummary')).toBe(true);
  });
});
