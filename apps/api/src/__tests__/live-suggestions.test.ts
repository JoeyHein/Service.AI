/**
 * Live Postgres tests for TASK-DI-05 dispatch suggestion API.
 *
 * Uses a scripted stubAIClient so the dispatcher agent emits a
 * deterministic sequence: list jobs → list techs → propose two
 * assignments (one high-confidence, one low) → stop. The test
 * asserts the runner auto-applies the high-confidence one and
 * queues the low-confidence one.
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
let cookies: {
  denverDispatcher: string;
  denverTech: string;
  austinOwner: string;
};
let ids: { franchisorId: string; denverId: string; austinId: string };
let denverTechUserId: string;
let jobA: string;
let jobB: string;

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

async function buildApplicationWithScript(script: AssistantTurn[]) {
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

  // Build an app with an empty script for sign-in; each test
  // constructs its own app with a scripted AI.
  app = await buildApplicationWithScript([]);
  cookies = {
    denverDispatcher: await signIn('denver.dispatcher@elevateddoors.test'),
    denverTech: await signIn('denver.tech1@elevateddoors.test'),
    austinOwner: await signIn('austin.owner@elevateddoors.test'),
  };

  const db = drizzle(pool, { schema });
  const tech = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, 'denver.tech1@elevateddoors.test'));
  denverTechUserId = tech[0]!.id;

  // Seed two unassigned denver jobs.
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (franchisee_id, name, latitude, longitude)
       VALUES ($1, 'Seed Customer', 39.74, -104.99) RETURNING id`,
    [ids.denverId],
  );
  const customerId = cust.rows[0]!.id;
  const insert = async (title: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO jobs (franchisee_id, customer_id, title, status)
         VALUES ($1, $2, $3, 'unassigned') RETURNING id`,
      [ids.denverId, customerId, title],
    );
    return r.rows[0]!.id;
  };
  jobA = await insert('Job A — springs');
  jobB = await insert('Job B — inspection');
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('DI-05 / trigger + list + approve + reject', () => {
  it('anonymous POST /suggest → 401', async () => {
    const a = await buildApplicationWithScript([]);
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/dispatch/suggest',
    });
    expect(res.statusCode).toBe(401);
    await a.close();
  });

  it('tech cannot trigger → 403', async () => {
    const a = await buildApplicationWithScript([]);
    const cookie = await signInHelper(a, 'denver.tech1@elevateddoors.test');
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/dispatch/suggest',
      headers: { cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
    await a.close();
  });

  it('dispatcher triggers a run: high-confidence auto-applies, low queues', async () => {
    const futureStart = new Date(Date.now() + 2 * 3600_000).toISOString();
    const futureEnd = new Date(Date.now() + 3 * 3600_000).toISOString();
    const farFutureStart = new Date(Date.now() + 5 * 3600_000).toISOString();
    const farFutureEnd = new Date(Date.now() + 6 * 3600_000).toISOString();
    const script: AssistantTurn[] = [
      toolUse('listUnassignedJobs', {}),
      toolUse('listTechs', {}),
      toolUse('proposeAssignment', {
        jobId: jobA,
        techUserId: denverTechUserId,
        scheduledStart: futureStart,
        scheduledEnd: futureEnd,
        reasoning: 'Closest tech with open morning',
        confidence: 0.9,
      }),
      toolUse('proposeAssignment', {
        jobId: jobB,
        techUserId: denverTechUserId,
        scheduledStart: farFutureStart,
        scheduledEnd: farFutureEnd,
        reasoning: 'Backup slot, less certain',
        confidence: 0.55,
      }),
      text('Proposed 2 assignments, 1 auto-applied and 1 queued.'),
    ];
    const a = await buildApplicationWithScript(script);
    const cookie = await signInHelper(a, 'denver.dispatcher@elevateddoors.test');
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/dispatch/suggest',
      headers: { cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as {
      proposals: number;
      autoApplied: number;
      queued: number;
    };
    expect(data.proposals).toBe(2);
    expect(data.autoApplied).toBe(1);
    expect(data.queued).toBe(1);

    // Job A should now be scheduled + assigned.
    const { rows: jobARows } = await pool.query<{
      status: string;
      assigned_tech_user_id: string | null;
    }>(`SELECT status, assigned_tech_user_id FROM jobs WHERE id = $1`, [jobA]);
    expect(jobARows[0]?.status).toBe('scheduled');
    expect(jobARows[0]?.assigned_tech_user_id).toBe(denverTechUserId);

    // Job B is still unassigned.
    const { rows: jobBRows } = await pool.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id = $1`,
      [jobB],
    );
    expect(jobBRows[0]?.status).toBe('unassigned');
    await a.close();
  });

  it('GET /suggestions?status=pending lists the queued row', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dispatch/suggestions?status=pending',
      headers: { cookie: cookies.denverDispatcher },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data.rows as Array<{ subjectJobId: string; status: string }>;
    expect(rows.some((r) => r.subjectJobId === jobB)).toBe(true);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
  });

  it('approve applies the pending suggestion + flips status', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/dispatch/suggestions?status=pending',
      headers: { cookie: cookies.denverDispatcher },
    });
    const pending = (list.json().data.rows as Array<{ id: string; subjectJobId: string }>).find(
      (r) => r.subjectJobId === jobB,
    )!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/dispatch/suggestions/${pending.id}/approve`,
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('applied');

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id = $1`,
      [jobB],
    );
    expect(rows[0]?.status).toBe('scheduled');
  });

  it('cross-tenant approve → 404', async () => {
    // Insert an austin job + suggestion, then try to approve as denver dispatcher.
    const austinCust = await pool.query<{ id: string }>(
      `INSERT INTO customers (franchisee_id, name) VALUES ($1, 'Austin C') RETURNING id`,
      [ids.austinId],
    );
    const austinJob = await pool.query<{ id: string }>(
      `INSERT INTO jobs (franchisee_id, customer_id, title, status)
         VALUES ($1, $2, 'austin private', 'unassigned') RETURNING id`,
      [ids.austinId, austinCust.rows[0]!.id],
    );
    const sugg = await pool.query<{ id: string }>(
      `INSERT INTO ai_suggestions
         (franchisee_id, kind, subject_job_id, proposed_tech_user_id,
          reasoning, confidence, status)
         VALUES ($1, 'assignment', $2, NULL, 'shh', 0.9, 'pending') RETURNING id`,
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
});

async function signInHelper(a: FastifyInstance, email: string): Promise<string> {
  const res = await a.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD }),
  });
  const raw = res.headers['set-cookie'];
  const s = Array.isArray(raw) ? raw[0]! : (raw as string);
  const m = s.match(/^([^=]+=[^;]+)/);
  if (!m) throw new Error('no cookie');
  return m[1]!;
}

