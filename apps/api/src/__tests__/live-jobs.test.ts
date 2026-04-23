/**
 * Live Postgres tests for TASK-CJ-03 jobs CRUD + status machine.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
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

const { Pool } = pkg;
const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let cookies: { denverOwner: string; austinOwner: string };
let denverCustomerId: string;
let austinCustomerId: string;

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

async function makeCustomer(cookie: string, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/customers',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ name }),
  });
  if (res.statusCode !== 201) throw new Error(`customer create failed: ${res.body}`);
  return res.json().data.id as string;
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await runReset(pool);
  await runSeed(pool);
  const db = drizzle(pool, { schema });
  const auth = createAuth({
    db,
    authSchema: { user: users, session: sessions, account: accounts, verification: verifications },
    baseUrl: 'http://localhost',
    secret: 'x'.repeat(32),
  });
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
  });
  await app.ready();
  cookies = {
    denverOwner: await signIn('denver.owner@elevateddoors.test'),
    austinOwner: await signIn('austin.owner@elevateddoors.test'),
  };
  denverCustomerId = await makeCustomer(cookies.denverOwner, 'Denver Customer');
  austinCustomerId = await makeCustomer(cookies.austinOwner, 'Austin Customer');
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

async function createJob(cookie: string, customerId: string, title = 'Install 2-car door') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ customerId, title }),
  });
  return res;
}

describe('CJ-03 / jobs CRUD', () => {
  it('anonymous: 401 on every job endpoint', async () => {
    const checks = [
      { method: 'GET' as const, url: '/api/v1/jobs' },
      { method: 'POST' as const, url: '/api/v1/jobs', body: true },
      { method: 'GET' as const, url: '/api/v1/jobs/11111111-1111-1111-1111-111111111111' },
      { method: 'PATCH' as const, url: '/api/v1/jobs/11111111-1111-1111-1111-111111111111', body: true },
      { method: 'POST' as const, url: '/api/v1/jobs/11111111-1111-1111-1111-111111111111/transition', body: true },
    ];
    for (const c of checks) {
      const init: { method: typeof c.method; url: string; headers?: Record<string, string>; payload?: string } = {
        method: c.method,
        url: c.url,
      };
      if (c.body) {
        init.headers = { 'content-type': 'application/json' };
        init.payload = '{}';
      }
      const res = await app.inject(init);
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(401);
    }
  });

  it('creates a job in the caller\'s franchisee with default status unassigned', async () => {
    const res = await createJob(cookies.denverOwner, denverCustomerId);
    expect(res.statusCode).toBe(201);
    expect(res.json().data.status).toBe('unassigned');
    expect(res.json().data.title).toBe('Install 2-car door');
  });

  it('rejects creating a job bound to a customer in another franchisee', async () => {
    const res = await createJob(cookies.denverOwner, austinCustomerId, 'Hijack attempt');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TARGET');
  });

  it('cross-tenant IDOR: austin cannot read a denver job', async () => {
    const created = await createJob(cookies.denverOwner, denverCustomerId, 'Denver only');
    const id = created.json().data.id as string;
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${id}`,
      headers: { cookie: cookies.austinOwner },
    });
    expect(read.statusCode).toBe(404);
  });

  it('list filters by status + customer, no cross-franchisee leak', async () => {
    await createJob(cookies.denverOwner, denverCustomerId, 'Filter job A');
    await createJob(cookies.austinOwner, austinCustomerId, 'Austin job');
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs?customerId=${denverCustomerId}`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json().data.rows as { title: string; customerId: string }[];
    expect(rows.every((r) => r.customerId === denverCustomerId)).toBe(true);
    expect(rows.map((r) => r.title)).not.toContain('Austin job');
  });

  it('PATCH updates non-status fields; status stays the same', async () => {
    const created = await createJob(cookies.denverOwner, denverCustomerId, 'Initial title');
    const id = created.json().data.id as string;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/jobs/${id}`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'Updated title', description: 'more info' }),
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().data.title).toBe('Updated title');
    expect(patch.json().data.status).toBe('unassigned');
  });
});

describe('CJ-03 / status transition endpoint', () => {
  it('valid sequence: unassigned → scheduled → en_route → arrived → in_progress → completed', async () => {
    const create = await createJob(cookies.denverOwner, denverCustomerId, 'Full lifecycle');
    const id = create.json().data.id as string;
    const seq: Array<string> = [
      'scheduled',
      'en_route',
      'arrived',
      'in_progress',
      'completed',
    ];
    for (const to of seq) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${id}/transition`,
        headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
        payload: JSON.stringify({ toStatus: to }),
      });
      expect(res.statusCode, `transition to ${to}`).toBe(200);
      expect(res.json().data.status).toBe(to);
    }
  });

  it('rejects illegal transitions with 409 INVALID_TRANSITION', async () => {
    const create = await createJob(cookies.denverOwner, denverCustomerId, 'Skip ahead');
    const id = create.json().data.id as string;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${id}/transition`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ toStatus: 'completed' }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_TRANSITION');
  });

  it('terminal states reject any further transition', async () => {
    const create = await createJob(cookies.denverOwner, denverCustomerId, 'Canceling');
    const id = create.json().data.id as string;
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${id}/transition`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ toStatus: 'canceled' }),
    });
    expect(cancel.statusCode).toBe(200);
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${id}/transition`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ toStatus: 'unassigned' }),
    });
    expect(again.statusCode).toBe(409);
  });

  it('writes a job_status_log row per transition (same transaction as the status update)', async () => {
    const create = await createJob(cookies.denverOwner, denverCustomerId, 'Log check');
    const id = create.json().data.id as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${id}/transition`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ toStatus: 'scheduled', reason: 'demo' }),
    });
    const { rows } = await pool.query(
      `SELECT from_status, to_status, reason FROM job_status_log WHERE job_id = $1 ORDER BY created_at`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { from_status: string; to_status: string }).from_status).toBe('unassigned');
    expect((rows[0] as { from_status: string; to_status: string }).to_status).toBe('scheduled');
    expect((rows[0] as { reason: string }).reason).toBe('demo');
  });

  it('sets actual_start on arrived and actual_end on completed', async () => {
    const create = await createJob(cookies.denverOwner, denverCustomerId, 'Timestamps');
    const id = create.json().data.id as string;
    for (const to of ['scheduled', 'en_route', 'arrived']) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${id}/transition`,
        headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
        payload: JSON.stringify({ toStatus: to }),
      });
    }
    const afterArrived = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${id}`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(afterArrived.json().data.actualStart).toBeTruthy();
    expect(afterArrived.json().data.actualEnd).toBeNull();

    for (const to of ['in_progress', 'completed']) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${id}/transition`,
        headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
        payload: JSON.stringify({ toStatus: to }),
      });
    }
    const afterCompleted = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${id}`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(afterCompleted.json().data.actualEnd).toBeTruthy();
  });

  it('cross-tenant transition returns 404', async () => {
    const create = await createJob(cookies.denverOwner, denverCustomerId, 'Protect');
    const id = create.json().data.id as string;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${id}/transition`,
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ toStatus: 'scheduled' }),
    });
    expect(res.statusCode).toBe(404);
  });
});
