/**
 * End-to-end synthesized-call tests for the AI CSR voice loop
 * (TASK-CV-07).
 *
 * We drive the orchestrator with a scripted AI client so the
 * agent's tool sequence is deterministic. The tools themselves
 * run against the real DB, so we can assert the customer +
 * job + ai_messages rows that land.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import * as schema from '@service-ai/db';
import {
  callSessions,
  jobs,
  franchisees,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import { runReset, runSeed } from '../seed/index.js';
import {
  buildCsrToolSet,
  CSR_GATED_TOOLS,
  type CsrToolDeps,
} from '../ai-tools/csr-tools.js';
import {
  stubAIClient,
  stubAsrClient,
  stubTtsClient,
  CallOrchestrator,
  resolveTenantByToNumber,
  type AssistantTurn,
} from '@service-ai/ai';

const { Pool } = pkg;
const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let ids: { franchisorId: string; denverId: string; austinId: string };

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

function toolUse(
  name: string,
  input: Record<string, unknown>,
  confidence = 0.95,
): AssistantTurn {
  return {
    role: 'assistant',
    kind: 'tool_use',
    toolUseId: `tu_${name}_${Date.now()}_${Math.random()}`,
    toolName: name,
    toolInput: input,
    confidence,
    costUsd: 0.001,
    provider: 'stub',
    model: 'stub-1',
  };
}

function text(t: string): AssistantTurn {
  return {
    role: 'assistant',
    kind: 'text',
    text: t,
    confidence: 1,
    costUsd: 0.0005,
    provider: 'stub',
    model: 'stub-1',
  };
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await runReset(pool);
  const seed = await runSeed(pool);
  ids = {
    franchisorId: seed.franchisorId,
    denverId: seed.franchisees.find((f) => f.slug === 'denver')!.id,
    austinId: seed.franchisees.find((f) => f.slug === 'austin')!.id,
  };
  db = drizzle(pool, { schema });
  // Stamp Denver with the deterministic provisioning number
  // so call-context resolves it.
  await pool.query(
    `UPDATE franchisees SET twilio_phone_number = $1 WHERE id = $2`,
    ['+15551234567', ids.denverId],
  );
}, 60_000);

afterAll(async () => {
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

function denverScope(): RequestScope {
  return {
    type: 'franchisee',
    userId: 'system-voice',
    role: 'csr',
    franchisorId: ids.franchisorId,
    franchiseeId: ids.denverId,
  };
}

async function runSynthesizedCall(script: AssistantTurn[], audioId?: string) {
  const tenant = await resolveTenantByToNumber(db, '+15551234567');
  expect(tenant).not.toBeNull();

  const ai = stubAIClient({ script });
  const asr = stubAsrClient({
    scripts: audioId
      ? { [audioId]: ['Hi, my garage door spring snapped'] }
      : {},
    defaultScript: ['Hi, my garage door spring snapped'],
  });
  const tts = stubTtsClient();

  const orch = new CallOrchestrator({
    db,
    ai,
    asr,
    tts,
    buildTools: ({ conversationId, tenant: t }) => {
      const deps: CsrToolDeps = {
        db,
        conversationId,
        state: {},
        async runScoped(fn) {
          const scope: RequestScope = {
            type: 'franchisee',
            userId: 'system-voice',
            role: 'csr',
            franchisorId: t.franchisorId,
            franchiseeId: t.franchiseeId,
          };
          return withScope(db, scope, fn);
        },
      };
      return buildCsrToolSet(deps);
    },
    gatedTools: CSR_GATED_TOOLS,
    callSid: `CA_test_${Math.random().toString(36).slice(2, 8)}`,
    tenant: tenant!,
    fromE164: '+15557654321',
    toE164: '+15551234567',
    audioId,
  });
  await orch.start();
  return { orch, result: await orch.run() };
}

describe('CV-07 / synthesized call happy path', () => {
  it('books a job end-to-end: lookup → create → propose → book → log', async () => {
    const script: AssistantTurn[] = [
      toolUse('lookupCustomer', { phone: '+15557654321' }),
      toolUse('createCustomer', {
        name: 'Pat Caller',
        phone: '+15557654321',
      }),
      toolUse('proposeTimeSlots', {}),
      toolUse('bookJob', {
        title: 'Garage door spring replacement',
        description: 'Snapped torsion spring',
        scheduledStart: new Date(Date.now() + 3600_000).toISOString(),
      }),
      toolUse('logCallSummary', {
        summary: 'Booked a spring replacement for Pat Caller tomorrow.',
        intent: 'repair',
        outcome: 'booked',
      }),
      text('Perfect — you are booked. Talk to you soon!'),
    ];
    const { result } = await runSynthesizedCall(script);
    expect(result.outcome).toBe('booked');

    const toolNames = result.transcript
      .filter((t) => t.role === 'tool')
      .map((t) => t.tool!.name);
    expect(toolNames).toEqual([
      'lookupCustomer',
      'createCustomer',
      'proposeTimeSlots',
      'bookJob',
      'logCallSummary',
    ]);

    // Job appears in the denver franchisee's jobs.
    const denverJobs = await withScope(db, denverScope(), (tx) =>
      tx.select().from(jobs).where(eq(jobs.franchiseeId, ids.denverId)),
    );
    expect(
      denverJobs.some((j) => j.title === 'Garage door spring replacement'),
    ).toBe(true);

    // call_sessions row recorded with outcome=booked
    const rows = await withScope(db, denverScope(), (tx) =>
      tx
        .select()
        .from(callSessions)
        .where(eq(callSessions.id, result.callSessionId)),
    );
    expect(rows[0]?.outcome).toBe('booked');
    expect(rows[0]?.status).toBe('completed');
  });
});

describe('CV-07 / adversarial', () => {
  it('low-confidence bookJob → transferToHuman (gated tool redirect)', async () => {
    const script: AssistantTurn[] = [
      // Low-confidence bookJob triggers the guardrail redirect.
      toolUse(
        'bookJob',
        { title: 'shady booking' },
        0.3,
      ),
      text('Never reached'),
    ];
    const { result } = await runSynthesizedCall(script);
    expect(result.outcome).toBe('transferred');
    const tools = result.transcript.filter((t) => t.role === 'tool');
    // First tool is transferToHuman (the redirect), not bookJob.
    expect(tools[0]!.tool!.name).toBe('transferToHuman');
  });

  it('cross-tenant customerId → INVALID_TARGET, loop continues', async () => {
    // Insert a customer into Austin directly.
    const austinScope: RequestScope = {
      type: 'franchisee',
      userId: 'system',
      role: 'csr',
      franchisorId: ids.franchisorId,
      franchiseeId: ids.austinId,
    };
    const austinCustomerId = await withScope(db, austinScope, async (tx) => {
      const rows = await tx
        .insert(schema.customers)
        .values({ franchiseeId: ids.austinId, name: 'Austin Ghost' })
        .returning();
      return rows[0]!.id;
    });
    const script: AssistantTurn[] = [
      toolUse('bookJob', {
        customerId: austinCustomerId,
        title: 'cross-tenant attempt',
      }),
      toolUse('logCallSummary', {
        summary: 'Couldn\'t book; bad customer.',
        intent: 'repair',
        outcome: 'abandoned',
      }),
      text('Sorry, something went wrong. Goodbye.'),
    ];
    const { result } = await runSynthesizedCall(script);
    const bookTool = result.transcript.find(
      (t) => t.role === 'tool' && t.tool?.name === 'bookJob',
    );
    expect(bookTool?.tool?.result.ok).toBe(false);
    expect(bookTool?.tool?.result.error?.code).toBe('INVALID_TARGET');
    // No Austin jobs got written from a Denver call.
    const rows = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM jobs WHERE franchisee_id = $1`,
      [ids.austinId],
    );
    expect(Number(rows.rows[0]?.c)).toBe(0);
  });

  it('unknown inbound number → resolveTenantByToNumber returns null', async () => {
    const tenant = await resolveTenantByToNumber(db, '+19995550000');
    expect(tenant).toBeNull();
  });
});

// Minimal touch to keep the unused-import eliminator happy.
void franchisees;
void and;
