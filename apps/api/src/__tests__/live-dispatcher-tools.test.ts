/**
 * Live Postgres tests for the dispatcher tool suite (TASK-DI-03).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@service-ai/db';
import {
  withScope,
  type RequestScope,
  type ScopedTx,
} from '@service-ai/db';
import { runReset, runSeed } from '../seed/index.js';
import {
  buildDispatcherToolSet,
  type DispatcherToolDeps,
  type ProposedAssignment,
} from '../ai-tools/dispatcher-tools.js';
import { stubDistanceMatrixClient } from '../distance-matrix.js';
import type { ToolContext } from '@service-ai/ai';

const { Pool } = pkg;
const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let ids: { franchisorId: string; denverId: string; austinId: string };
let denverTechUserId: string;
let denverJobId: string;
let captured: ProposedAssignment[];

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

function denverScope(): RequestScope {
  return {
    type: 'franchisee',
    userId: 'dispatcher-bot',
    role: 'dispatcher',
    franchisorId: ids.franchisorId,
    franchiseeId: ids.denverId,
  };
}

function makeDeps(): DispatcherToolDeps {
  captured = [];
  return {
    db,
    distanceMatrix: stubDistanceMatrixClient,
    captured: { proposals: captured },
    async runScoped<T>(fn: (tx: ScopedTx) => Promise<T>) {
      return withScope(db, denverScope(), fn);
    },
  };
}

const ctx: ToolContext = {
  franchiseeId: '', // set in beforeAll
  userId: null,
  guardrails: {
    confidenceThreshold: 0.8,
    undoWindowSeconds: 900,
    transferOnLowConfidence: true,
  },
  invocation: { confidence: 1 },
};

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
  ctx.franchiseeId = ids.denverId;
  db = drizzle(pool, { schema });

  // Resolve the denver tech user id + create a customer + job for tests.
  const tech = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, 'denver.tech1@elevateddoors.test'));
  denverTechUserId = tech[0]!.id;

  const custRow = await withScope(db, denverScope(), (tx) =>
    tx
      .insert(schema.customers)
      .values({
        franchiseeId: ids.denverId,
        name: 'Dispatcher Test Customer',
        latitude: '39.74' as unknown as string,
        longitude: '-104.99' as unknown as string,
      })
      .returning(),
  );
  const customerId = custRow[0]!.id;

  const jobRow = await withScope(db, denverScope(), (tx) =>
    tx
      .insert(schema.jobs)
      .values({
        franchiseeId: ids.denverId,
        customerId,
        title: 'DI-03 open job',
        status: 'unassigned',
      })
      .returning(),
  );
  denverJobId = jobRow[0]!.id;
}, 60_000);

afterAll(async () => {
  if (pool) await pool.end();
});

beforeEach((testCtx) => {
  if (!reachable) testCtx.skip();
});

describe('DI-03 / listUnassignedJobs', () => {
  it('returns the open job with customer lat/lng', async () => {
    const tools = buildDispatcherToolSet(makeDeps());
    const res = await tools.listUnassignedJobs!.execute({}, ctx);
    expect(res.ok).toBe(true);
    const out = res.data as { jobs: Array<{ id: string; latitude: number | null }> };
    expect(out.jobs.some((j) => j.id === denverJobId)).toBe(true);
    const targetJob = out.jobs.find((j) => j.id === denverJobId)!;
    expect(targetJob.latitude).toBe(39.74);
  });
});

describe('DI-03 / listTechs', () => {
  it('lists active denver tech memberships', async () => {
    const tools = buildDispatcherToolSet(makeDeps());
    const res = await tools.listTechs!.execute({}, ctx);
    expect(res.ok).toBe(true);
    const out = res.data as { techs: Array<{ userId: string }> };
    expect(out.techs.some((t) => t.userId === denverTechUserId)).toBe(true);
  });

  it('filters by skill when provided', async () => {
    // Add a skill for denver tech1.
    await pool.query(
      `INSERT INTO tech_skills (user_id, franchisee_id, skill)
         VALUES ($1, $2, 'springs')
       ON CONFLICT DO NOTHING`,
      [denverTechUserId, ids.denverId],
    );
    const tools = buildDispatcherToolSet(makeDeps());
    const withSkill = await tools.listTechs!.execute({ skill: 'springs' }, ctx);
    const without = await tools.listTechs!.execute({ skill: 'cables' }, ctx);
    expect(((withSkill.data as { techs: unknown[] }).techs).length).toBeGreaterThan(0);
    expect(((without.data as { techs: unknown[] }).techs).length).toBe(0);
  });
});

describe('DI-03 / getTechCurrentLoad', () => {
  it('returns zeros when no jobs are scheduled today', async () => {
    const tools = buildDispatcherToolSet(makeDeps());
    const res = await tools.getTechCurrentLoad!.execute(
      { techUserId: denverTechUserId },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect((res.data as { activeCount: number }).activeCount).toBe(0);
  });

  it('cross-tenant tech → INVALID_TARGET', async () => {
    const tools = buildDispatcherToolSet(makeDeps());
    const res = await tools.getTechCurrentLoad!.execute(
      { techUserId: 'austin-stranger-id' },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('INVALID_TARGET');
  });
});

describe('DI-03 / computeTravelTime', () => {
  it('returns a driving estimate via the stub adapter', async () => {
    const tools = buildDispatcherToolSet(makeDeps());
    const res = await tools.computeTravelTime!.execute(
      { fromLat: 39.74, fromLng: -104.99, toLat: 39.76, toLng: -104.98 },
      ctx,
    );
    expect(res.ok).toBe(true);
    const data = res.data as {
      durationSeconds: number;
      provider: string;
    };
    expect(data.provider).toBe('stub');
    expect(data.durationSeconds).toBeGreaterThan(0);
  });
});

describe('DI-03 / proposeAssignment', () => {
  it('captures the proposal when job + tech both belong to the franchisee', async () => {
    const deps = makeDeps();
    const tools = buildDispatcherToolSet(deps);
    const res = await tools.proposeAssignment!.execute(
      {
        jobId: denverJobId,
        techUserId: denverTechUserId,
        scheduledStart: new Date(Date.now() + 3600_000).toISOString(),
        reasoning: 'Closest tech with matching skill',
        confidence: 0.9,
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(deps.captured.proposals).toHaveLength(1);
    expect(deps.captured.proposals[0]!.confidence).toBe(0.9);
  });

  it('cross-tenant jobId → INVALID_TARGET, nothing captured', async () => {
    // Insert an austin job directly.
    const austinCustomer = await pool.query<{ id: string }>(
      `INSERT INTO customers (franchisee_id, name) VALUES ($1, 'Austin Ghost') RETURNING id`,
      [ids.austinId],
    );
    const austinJob = await pool.query<{ id: string }>(
      `INSERT INTO jobs (franchisee_id, customer_id, title, status)
         VALUES ($1, $2, 'austin ghost job', 'unassigned') RETURNING id`,
      [ids.austinId, austinCustomer.rows[0]!.id],
    );
    const deps = makeDeps();
    const tools = buildDispatcherToolSet(deps);
    const res = await tools.proposeAssignment!.execute(
      {
        jobId: austinJob.rows[0]!.id,
        techUserId: denverTechUserId,
        scheduledStart: new Date(Date.now() + 3600_000).toISOString(),
        reasoning: 'should fail',
        confidence: 0.9,
      },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('INVALID_TARGET');
    expect(deps.captured.proposals).toHaveLength(0);
  });
});

describe('DI-03 / applyAssignment', () => {
  it('applies a proposed assignment (happy path)', async () => {
    // Use a fresh job to avoid interaction with other tests.
    const custRow = await withScope(db, denverScope(), (tx) =>
      tx
        .insert(schema.customers)
        .values({ franchiseeId: ids.denverId, name: 'Apply Target' })
        .returning(),
    );
    const jobRow = await withScope(db, denverScope(), (tx) =>
      tx
        .insert(schema.jobs)
        .values({
          franchiseeId: ids.denverId,
          customerId: custRow[0]!.id,
          title: 'apply target',
          status: 'unassigned',
        })
        .returning(),
    );
    const tools = buildDispatcherToolSet(makeDeps());
    const res = await tools.applyAssignment!.execute(
      {
        jobId: jobRow[0]!.id,
        techUserId: denverTechUserId,
        scheduledStart: new Date(Date.now() + 3600_000).toISOString(),
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect((res.data as { status: string }).status).toBe('scheduled');

    const rows = await withScope(db, denverScope(), (tx) =>
      tx.select().from(schema.jobs).where(eq(schema.jobs.id, jobRow[0]!.id)),
    );
    expect(rows[0]?.assignedTechUserId).toBe(denverTechUserId);
  });
});
