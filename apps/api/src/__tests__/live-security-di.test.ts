/**
 * TASK-DI-08 — phase_ai_dispatcher security suite.
 *
 * Exercises the suggestions API against the threat model:
 * anonymous 401s, role boundary (dispatcher / franchisee_owner
 * only + admins), cross-tenant approve/reject, stale-suggestion
 * 409, scheduling-invariant enforcement when the runner
 * auto-applies.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createAuth } from '@service-ai/auth';
import * as schema from '@service-ai/db';
import { users, sessions, accounts, verifications } from '@service-ai/db';
import { buildApp } from '../app.js';
import { runReset, runSeed, DEV_SEED_PASSWORD } from '../seed/index.js';
import {
  membershipResolver,
  franchiseeLookup,
  auditLogWriter,
} from '../production-resolvers.js';
import { stubAIClient, type AssistantTurn } from '@service-ai/ai';

const { Pool } = pkg;
const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let ids: { franchisorId: string; denverId: string; austinId: string };
let cookies: {
  denverDispatcher: string;
  denverOwner: string;
  denverTech: string;
  austinOwner: string;
  austinTech: string;
};
let denverTech1Id: string;
let denverTech2Id: string;

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

function extractCookie(set: string | string[] | undefined): string | null {
  if (!set) return null;
  const s = Array.isArray(set) ? set[0]! : set;
  const m = s.match(/^([^=]+=[^;]+)/);
  return m ? m[1]! : null;
}

async function signIn(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD }),
  });
  const c = extractCookie(res.headers['set-cookie']);
  if (!c) throw new Error('no cookie');
  return c;
}

function toolUse(
  name: string,
  input: Record<string, unknown>,
  confidence = 0.95,
): AssistantTurn {
  return {
    role: 'assistant',
    kind: 'tool_use',
    toolUseId: `tu_${name}_${Math.random().toString(36).slice(2)}`,
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
    costUsd: 0,
    provider: 'stub',
    model: 'stub-1',
  };
}

async function buildApplication(script: AssistantTurn[] = []) {
  const ai = stubAIClient({ script });
  const db = drizzle(pool, { schema });
  const auth = createAuth({
    db,
    authSchema: { user: users, session: sessions, account: accounts, verification: verifications },
    baseUrl: 'http://localhost',
    secret: 'x'.repeat(32),
  });
  const a = buildApp({
    db: { query: async () => ({ rows: [] }) },
    redis: { ping: async () => 'PONG' },
    logger: false,
    auth,
    drizzle: db,
    membershipResolver: membershipResolver(db),
    franchiseeLookup: franchiseeLookup(db),
    auditWriter: auditLogWriter(db),
    magicLinkSender: { async send() {} },
    acceptUrlBase: 'http://localhost:3000',
    aiClient: ai,
  });
  await a.ready();
  return a;
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
  app = await buildApplication([]);
  cookies = {
    denverDispatcher: await signIn('denver.dispatcher@elevateddoors.test'),
    denverOwner: await signIn('denver.owner@elevateddoors.test'),
    denverTech: await signIn('denver.tech1@elevateddoors.test'),
    austinOwner: await signIn('austin.owner@elevateddoors.test'),
    austinTech: await signIn('austin.tech1@elevateddoors.test'),
  };
  const db = drizzle(pool, { schema });
  const tech1 = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'denver.tech1@elevateddoors.test'));
  denverTech1Id = tech1[0]!.id;
  const tech2 = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'denver.tech2@elevateddoors.test'));
  denverTech2Id = tech2[0]!.id;
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

// ---------------------------------------------------------------------------
// Anonymous 401
// ---------------------------------------------------------------------------

describe('DI-08 / anonymous 401', () => {
  const ops: Array<{ method: 'POST' | 'GET'; url: string; body?: string }> = [
    { method: 'POST', url: '/api/v1/dispatch/suggest', body: '{}' },
    { method: 'GET', url: '/api/v1/dispatch/suggestions' },
    { method: 'GET', url: '/api/v1/dispatch/metrics?date=2026-04-24' },
    { method: 'POST', url: '/api/v1/dispatch/suggestions/00000000-0000-0000-0000-000000000000/approve', body: '{}' },
    { method: 'POST', url: '/api/v1/dispatch/suggestions/00000000-0000-0000-0000-000000000000/reject', body: '{}' },
  ];
  for (const op of ops) {
    it(`${op.method} ${op.url} anonymous → 401`, async () => {
      const res = await app.inject({
        method: op.method,
        url: op.url,
        headers: op.body ? { 'content-type': 'application/json' } : {},
        payload: op.body,
      });
      expect(res.statusCode).toBe(401);
    });
  }
});

// ---------------------------------------------------------------------------
// Role boundary
// ---------------------------------------------------------------------------

describe('DI-08 / role boundary', () => {
  it('tech cannot trigger run → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/dispatch/suggest',
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
  });

  it('tech cannot list suggestions → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dispatch/suggestions',
      headers: { cookie: cookies.denverTech },
    });
    expect(res.statusCode).toBe(403);
  });

  it('tech cannot approve → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/dispatch/suggestions/00000000-0000-0000-0000-000000000000/approve',
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
  });

  it('franchisee_owner CAN list suggestions', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dispatch/suggestions',
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(200);
  });

  it('dispatcher CAN trigger run', async () => {
    const a = await buildApplication([text('nothing to do')]);
    const cookie = await (async () => {
      const res = await a.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          email: 'denver.dispatcher@elevateddoors.test',
          password: DEV_SEED_PASSWORD,
        }),
      });
      return extractCookie(res.headers['set-cookie'])!;
    })();
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/dispatch/suggest',
      headers: { cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(201);
    await a.close();
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant visibility + approve/reject
// ---------------------------------------------------------------------------

describe('DI-08 / cross-tenant', () => {
  it('denver dispatcher listing only sees own-franchisee suggestions', async () => {
    // Insert a suggestion in austin directly.
    const austinCust = await pool.query<{ id: string }>(
      `INSERT INTO customers (franchisee_id, name) VALUES ($1, 'Aus') RETURNING id`,
      [ids.austinId],
    );
    const austinJob = await pool.query<{ id: string }>(
      `INSERT INTO jobs (franchisee_id, customer_id, title, status)
         VALUES ($1, $2, 'aus job', 'unassigned') RETURNING id`,
      [ids.austinId, austinCust.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO ai_suggestions
         (franchisee_id, kind, subject_job_id, reasoning, confidence, status)
         VALUES ($1, 'assignment', $2, 'aus only', 0.9, 'pending')`,
      [ids.austinId, austinJob.rows[0]!.id],
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dispatch/suggestions',
      headers: { cookie: cookies.denverDispatcher },
    });
    const rows = res.json().data.rows as Array<{ franchiseeId: string }>;
    for (const r of rows) expect(r.franchiseeId).toBe(ids.denverId);
  });

  it('cross-tenant approve → 404', async () => {
    const austinCust = await pool.query<{ id: string }>(
      `INSERT INTO customers (franchisee_id, name) VALUES ($1, 'Aus2') RETURNING id`,
      [ids.austinId],
    );
    const austinJob = await pool.query<{ id: string }>(
      `INSERT INTO jobs (franchisee_id, customer_id, title, status)
         VALUES ($1, $2, 'aus2 job', 'unassigned') RETURNING id`,
      [ids.austinId, austinCust.rows[0]!.id],
    );
    const sugg = await pool.query<{ id: string }>(
      `INSERT INTO ai_suggestions
         (franchisee_id, kind, subject_job_id, reasoning, confidence, status)
         VALUES ($1, 'assignment', $2, 'aus2', 0.9, 'pending') RETURNING id`,
      [ids.austinId, austinJob.rows[0]!.id],
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/dispatch/suggestions/${sugg.rows[0]!.id}/approve`,
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(404);
  });

  it('cross-tenant reject → 404', async () => {
    const austinCust = await pool.query<{ id: string }>(
      `INSERT INTO customers (franchisee_id, name) VALUES ($1, 'Aus3') RETURNING id`,
      [ids.austinId],
    );
    const austinJob = await pool.query<{ id: string }>(
      `INSERT INTO jobs (franchisee_id, customer_id, title, status)
         VALUES ($1, $2, 'aus3 job', 'unassigned') RETURNING id`,
      [ids.austinId, austinCust.rows[0]!.id],
    );
    const sugg = await pool.query<{ id: string }>(
      `INSERT INTO ai_suggestions
         (franchisee_id, kind, subject_job_id, reasoning, confidence, status)
         VALUES ($1, 'assignment', $2, 'aus3', 0.9, 'pending') RETURNING id`,
      [ids.austinId, austinJob.rows[0]!.id],
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/dispatch/suggestions/${sugg.rows[0]!.id}/reject`,
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// State machine + stale
// ---------------------------------------------------------------------------

describe('DI-08 / state machine', () => {
  it('approve on already-applied suggestion → 409', async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (franchisee_id, name) VALUES ($1, 'S1') RETURNING id`,
      [ids.denverId],
    );
    const job = await pool.query<{ id: string }>(
      `INSERT INTO jobs (franchisee_id, customer_id, title, status)
         VALUES ($1, $2, 's1', 'unassigned') RETURNING id`,
      [ids.denverId, cust.rows[0]!.id],
    );
    const sugg = await pool.query<{ id: string }>(
      `INSERT INTO ai_suggestions
         (franchisee_id, kind, subject_job_id, reasoning, confidence, status)
         VALUES ($1, 'assignment', $2, 's1', 0.9, 'applied') RETURNING id`,
      [ids.denverId, job.rows[0]!.id],
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/dispatch/suggestions/${sugg.rows[0]!.id}/approve`,
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SUGGESTION_NOT_PENDING');
  });

  it('approve with stale job (already scheduled) → 409', async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (franchisee_id, name) VALUES ($1, 'Stale') RETURNING id`,
      [ids.denverId],
    );
    const job = await pool.query<{ id: string }>(
      `INSERT INTO jobs (franchisee_id, customer_id, title, status, assigned_tech_user_id, scheduled_start)
         VALUES ($1, $2, 'stale', 'scheduled', $3, NOW()) RETURNING id`,
      [ids.denverId, cust.rows[0]!.id, denverTech1Id],
    );
    const sugg = await pool.query<{ id: string }>(
      `INSERT INTO ai_suggestions
         (franchisee_id, kind, subject_job_id, proposed_tech_user_id, reasoning, confidence, status)
         VALUES ($1, 'assignment', $2, $3, 'stale test', 0.9, 'pending') RETURNING id`,
      [ids.denverId, job.rows[0]!.id, denverTech2Id],
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/dispatch/suggestions/${sugg.rows[0]!.id}/approve`,
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('STALE_SUGGESTION');
  });

  it('non-UUID on approve → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/dispatch/suggestions/not-a-uuid/approve',
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(400);
  });

  it('bad date on metrics → 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dispatch/metrics?date=yesterday',
      headers: { cookie: cookies.denverDispatcher },
    });
    expect(res.statusCode).toBe(400);
  });

  it('metrics happy path returns a row shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dispatch/metrics?date=2026-04-24',
      headers: { cookie: cookies.denverDispatcher },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { suggestionsTotal: number };
    expect(typeof data.suggestionsTotal).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Scheduling correctness (invariants enforced by the runner)
// ---------------------------------------------------------------------------

describe('DI-08 / scheduling invariants', () => {
  it('double-booking proposal is queued, not auto-applied', async () => {
    // Seed: tech1 already has a 9am-11am scheduled job.
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (franchisee_id, name, latitude, longitude)
         VALUES ($1, 'Existing', 39.74, -104.99) RETURNING id`,
      [ids.denverId],
    );
    const existingStart = new Date(Date.now() + 2 * 3600_000);
    const existingEnd = new Date(existingStart.getTime() + 2 * 3600_000);
    await pool.query(
      `INSERT INTO jobs (franchisee_id, customer_id, title, status,
                         assigned_tech_user_id, scheduled_start, scheduled_end)
         VALUES ($1, $2, 'existing', 'scheduled', $3, $4, $5)`,
      [
        ids.denverId,
        cust.rows[0]!.id,
        denverTech1Id,
        existingStart,
        existingEnd,
      ],
    );
    // New unassigned job that overlaps.
    const newCust = await pool.query<{ id: string }>(
      `INSERT INTO customers (franchisee_id, name, latitude, longitude)
         VALUES ($1, 'Conflict', 39.74, -104.99) RETURNING id`,
      [ids.denverId],
    );
    const newJob = await pool.query<{ id: string }>(
      `INSERT INTO jobs (franchisee_id, customer_id, title, status)
         VALUES ($1, $2, 'conflict', 'unassigned') RETURNING id`,
      [ids.denverId, newCust.rows[0]!.id],
    );
    const overlapStart = new Date(existingStart.getTime() + 30 * 60_000);
    const overlapEnd = new Date(existingEnd.getTime() + 30 * 60_000);
    const script: AssistantTurn[] = [
      toolUse('proposeAssignment', {
        jobId: newJob.rows[0]!.id,
        techUserId: denverTech1Id,
        scheduledStart: overlapStart.toISOString(),
        scheduledEnd: overlapEnd.toISOString(),
        reasoning: 'Attempt to double-book',
        confidence: 0.95,
      }),
      text('Done.'),
    ];
    const a = await buildApplication(script);
    const cookie = await (async () => {
      const res = await a.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          email: 'denver.dispatcher@elevateddoors.test',
          password: DEV_SEED_PASSWORD,
        }),
      });
      return extractCookie(res.headers['set-cookie'])!;
    })();
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/dispatch/suggest',
      headers: { cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as {
      autoApplied: number;
      queued: number;
      suggestions: Array<{ rejectedInvariant?: string }>;
    };
    expect(data.autoApplied).toBe(0);
    expect(data.queued).toBe(1);
    expect(data.suggestions[0]!.rejectedInvariant).toBe('double_booked');
    await a.close();
  });

  it('missing-skill proposal (reasoning mentions required skill) is queued', async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (franchisee_id, name) VALUES ($1, 'Skills') RETURNING id`,
      [ids.denverId],
    );
    const job = await pool.query<{ id: string }>(
      `INSERT INTO jobs (franchisee_id, customer_id, title, status)
         VALUES ($1, $2, 'needs panorama', 'unassigned') RETURNING id`,
      [ids.denverId, cust.rows[0]!.id],
    );
    const script: AssistantTurn[] = [
      toolUse('proposeAssignment', {
        jobId: job.rows[0]!.id,
        techUserId: denverTech1Id,
        scheduledStart: new Date(Date.now() + 8 * 3600_000).toISOString(),
        scheduledEnd: new Date(Date.now() + 9 * 3600_000).toISOString(),
        reasoning: 'requires: panorama — no tech has this skill yet',
        confidence: 0.95,
      }),
      text('Done.'),
    ];
    const a = await buildApplication(script);
    const cookie = await (async () => {
      const res = await a.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          email: 'denver.dispatcher@elevateddoors.test',
          password: DEV_SEED_PASSWORD,
        }),
      });
      return extractCookie(res.headers['set-cookie'])!;
    })();
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/dispatch/suggest',
      headers: { cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    const data = res.json().data as {
      autoApplied: number;
      queued: number;
      suggestions: Array<{ rejectedInvariant?: string }>;
    };
    expect(data.autoApplied).toBe(0);
    expect(data.queued).toBe(1);
    expect(data.suggestions[0]!.rejectedInvariant).toMatch(/missing_skill/);
    await a.close();
  });
});

