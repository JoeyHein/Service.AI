/**
 * Live Postgres tests for TASK-DB-02 assignment API + TASK-DB-03 SSE
 * event stream. Verifies:
 *   - assign to a same-franchisee tech succeeds
 *   - cross-franchisee tech → 400 INVALID_TARGET
 *   - non-tech user (dispatcher) → 400 INVALID_TARGET
 *   - assigning an unassigned job auto-transitions to scheduled
 *   - unassign clears assigned_tech_user_id
 *   - SSE subscribers receive job.assigned events within 500 ms
 *   - SSE is scope-filtered: austin subscriber does not see denver event
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createAuth } from '@service-ai/auth';
import * as schema from '@service-ai/db';
import { users, sessions, accounts, verifications, memberships } from '@service-ai/db';
import { buildApp } from '../app.js';
import { runReset, runSeed, DEV_SEED_PASSWORD } from '../seed/index.js';
import {
  membershipResolver,
  franchiseeLookup,
  auditLogWriter,
} from '../production-resolvers.js';
import { inProcessEventBus, type EventBus, type DispatchEvent } from '../event-bus.js';

const { Pool } = pkg;
const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let bus: EventBus;
let ids: { denverId: string; austinId: string };
let cookies: { denverDispatcher: string; austinDispatcher: string };
let denverCustomerId: string;
let denverJobId: string;
let austinCustomerId: string;
let austinJobId: string;
let denverTechUserId: string;
let denverDispatcherUserId: string;
let austinTechUserId: string;

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
  if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.body}`);
  const c = extractCookie(res.headers['set-cookie']);
  if (!c) throw new Error('no cookie');
  return c;
}

async function resolveUserId(email: string): Promise<string> {
  const db = drizzle(pool, { schema });
  const r = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return r[0]!.id;
}

async function createCustomerAndJob(cookie: string, name: string) {
  const cust = await app.inject({
    method: 'POST',
    url: '/api/v1/customers',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ name }),
  });
  const customerId = cust.json().data.id as string;
  const job = await app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ customerId, title: `${name} job` }),
  });
  return { customerId, jobId: job.json().data.id as string };
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
  const db = drizzle(pool, { schema });
  const auth = createAuth({
    db,
    authSchema: { user: users, session: sessions, account: accounts, verification: verifications },
    baseUrl: 'http://localhost',
    secret: 'x'.repeat(32),
  });
  bus = inProcessEventBus();
  app = buildApp({
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
    eventBus: bus,
  });
  await app.ready();
  cookies = {
    denverDispatcher: await signIn('denver.dispatcher@elevateddoors.test'),
    austinDispatcher: await signIn('austin.dispatcher@elevateddoors.test'),
  };
  denverTechUserId = await resolveUserId('denver.tech1@elevateddoors.test');
  denverDispatcherUserId = await resolveUserId('denver.dispatcher@elevateddoors.test');
  austinTechUserId = await resolveUserId('austin.tech1@elevateddoors.test');
  ({ customerId: denverCustomerId, jobId: denverJobId } = await createCustomerAndJob(
    cookies.denverDispatcher,
    'Assignment denver',
  ));
  ({ customerId: austinCustomerId, jobId: austinJobId } = await createCustomerAndJob(
    cookies.austinDispatcher,
    'Assignment austin',
  ));
  void denverCustomerId;
  void austinCustomerId;
  void memberships;
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('DB-02 / assign', () => {
  it('anonymous: 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/assign`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ assignedTechUserId: denverTechUserId }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('assigns same-franchisee tech and auto-transitions to scheduled', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/assign`,
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: JSON.stringify({ assignedTechUserId: denverTechUserId }),
    });
    expect(res.statusCode).toBe(200);
    const job = res.json().data;
    expect(job.assignedTechUserId).toBe(denverTechUserId);
    expect(job.status).toBe('scheduled');

    // status log row was written for the auto-transition
    const { rows } = await pool.query(
      `SELECT to_status, reason FROM job_status_log WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [denverJobId],
    );
    expect((rows[0] as { to_status: string }).to_status).toBe('scheduled');
    expect((rows[0] as { reason: string }).reason).toBe('auto-transition on assign');
  });

  it('cross-franchisee tech → 400 INVALID_TARGET', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/assign`,
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: JSON.stringify({ assignedTechUserId: austinTechUserId }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TARGET');
  });

  it('non-tech user (dispatcher in same franchisee) → 400 INVALID_TARGET', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/assign`,
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: JSON.stringify({ assignedTechUserId: denverDispatcherUserId }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TARGET');
  });

  it('cross-tenant job → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/assign`,
      headers: { cookie: cookies.austinDispatcher, 'content-type': 'application/json' },
      payload: JSON.stringify({ assignedTechUserId: austinTechUserId }),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DB-02 / unassign', () => {
  it('clears assignment', async () => {
    // First assign, then unassign.
    await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${austinJobId}/assign`,
      headers: { cookie: cookies.austinDispatcher, 'content-type': 'application/json' },
      payload: JSON.stringify({ assignedTechUserId: austinTechUserId }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${austinJobId}/unassign`,
      headers: { cookie: cookies.austinDispatcher },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.assignedTechUserId).toBeNull();
  });
});

describe('DB-03 / SSE event bus (no HTTP stream — via direct bus subscribe)', () => {
  it('subscribers in scope receive job.assigned events', async () => {
    // Deterministic test against the bus directly — bus is the same
    // instance the routes publish to. This verifies the publish path
    // without depending on Fastify inject's SSE support.
    const events: DispatchEvent[] = [];
    const unsub = bus.subscribe(
      (e) => e.franchiseeId === ids.denverId,
      (e) => events.push(e),
    );
    try {
      const freshJob = await createCustomerAndJob(cookies.denverDispatcher, 'SSE denver');
      const before = Date.now();
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${freshJob.jobId}/assign`,
        headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
        payload: JSON.stringify({ assignedTechUserId: denverTechUserId }),
      });
      expect(res.statusCode).toBe(200);
      const elapsed = Date.now() - before;
      expect(elapsed).toBeLessThan(500);
      expect(events.length).toBeGreaterThan(0);
      expect(events.some((e) => e.type === 'job.assigned')).toBe(true);
      expect(events.some((e) => e.type === 'job.transitioned')).toBe(true);
    } finally {
      unsub();
    }
  });

  it('scope predicate excludes out-of-scope events', async () => {
    const events: DispatchEvent[] = [];
    const unsub = bus.subscribe(
      (e) => e.franchiseeId === ids.austinId,
      (e) => events.push(e),
    );
    try {
      const freshJob = await createCustomerAndJob(cookies.denverDispatcher, 'SSE scope filter');
      await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${freshJob.jobId}/assign`,
        headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
        payload: JSON.stringify({ assignedTechUserId: denverTechUserId }),
      });
      expect(events.length).toBe(0);
    } finally {
      unsub();
    }
  });
});
