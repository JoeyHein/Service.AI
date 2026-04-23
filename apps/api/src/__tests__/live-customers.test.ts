/**
 * Live Postgres CRUD tests for TASK-CJ-02.
 * Anonymous 401, create/list/read/update/soft-delete with scope
 * filtering, cross-tenant IDOR returns 404, idempotent delete.
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
let ids: { denverId: string; austinId: string };
let cookies: { denverOwner: string; austinOwner: string; denverDispatcher: string };

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
    denverDispatcher: await signIn('denver.dispatcher@elevateddoors.test'),
  };
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('CJ-02 / customers CRUD', () => {
  it('anonymous returns 401 on every method', async () => {
    for (const [method, url, hasBody] of [
      ['GET', '/api/v1/customers', false],
      ['POST', '/api/v1/customers', true],
      ['GET', '/api/v1/customers/11111111-1111-1111-1111-111111111111', false],
      ['PATCH', '/api/v1/customers/11111111-1111-1111-1111-111111111111', true],
      ['DELETE', '/api/v1/customers/11111111-1111-1111-1111-111111111111', false],
    ] as const) {
      // Fastify's JSON body parser rejects empty bodies when a
      // content-type is set — only send the header when we have a
      // payload to match.
      const init: { method: typeof method; url: string; headers?: Record<string, string>; payload?: string } = {
        method,
        url,
      };
      if (hasBody) {
        init.headers = { 'content-type': 'application/json' };
        init.payload = '{}';
      }
      const res = await app.inject(init);
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('denver owner creates + reads + lists + updates + deletes their customer', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Acme Overhead Doors',
        email: 'acme@example.test',
        phone: '555-0100',
        city: 'Denver',
        state: 'CO',
      }),
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().data.id as string;

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/customers?search=Acme',
      headers: { cookie: cookies.denverOwner },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.rows.map((r: { id: string }) => r.id)).toContain(id);
    expect(list.json().data.total).toBeGreaterThan(0);

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${id}`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data.name).toBe('Acme Overhead Doors');

    const update = await app.inject({
      method: 'PATCH',
      url: `/api/v1/customers/${id}`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ phone: '555-0111', notes: 'VIP' }),
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().data.phone).toBe('555-0111');
    expect(update.json().data.notes).toBe('VIP');

    const del1 = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customers/${id}`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(del1.statusCode).toBe(200);
    expect(del1.json().data.deleted).toBe(true);

    const del2 = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customers/${id}`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(del2.statusCode).toBe(200);
    expect(del2.json().data.alreadyDeleted).toBe(true);

    // Soft-deleted should be invisible to reads.
    const postDel = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${id}`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(postDel.statusCode).toBe(404);
  });

  it('cross-tenant IDOR: austin owner cannot read denver customer', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Denver Only Co' }),
    });
    const id = create.json().data.id as string;

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${id}`,
      headers: { cookie: cookies.austinOwner },
    });
    expect(read.statusCode).toBe(404);

    const update = await app.inject({
      method: 'PATCH',
      url: `/api/v1/customers/${id}`,
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ notes: 'hijacked' }),
    });
    expect(update.statusCode).toBe(404);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customers/${id}`,
      headers: { cookie: cookies.austinOwner },
    });
    expect(del.statusCode).toBe(404);
  });

  it('list returns only caller-scoped customers (no leak across franchisees)', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Denver Iso A' }),
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Austin Iso A' }),
    });

    const denverList = await app.inject({
      method: 'GET',
      url: '/api/v1/customers',
      headers: { cookie: cookies.denverOwner },
    });
    const names = denverList.json().data.rows.map((r: { name: string }) => r.name);
    expect(names).toContain('Denver Iso A');
    expect(names).not.toContain('Austin Iso A');
  });

  it('dispatcher in same franchisee can create + list customers', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Dispatch Created' }),
    });
    expect(create.statusCode).toBe(201);
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/customers',
      headers: { cookie: cookies.denverDispatcher },
    });
    const names = list.json().data.rows.map((r: { name: string }) => r.name);
    expect(names).toContain('Dispatch Created');
  });

  it('invalid body returns 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('non-UUID id returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/customers/not-a-uuid',
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(400);
  });

  it('cross-tenant locationId is rejected with 400 INVALID_TARGET', async () => {
    // Lookup a location that belongs to austin.
    const db = drizzle(pool, { schema });
    const [austinLoc] = await db
      .select()
      .from(schema.locations)
      .where(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (schema.locations as any).franchiseeId
          ? // drizzle eq via column reference
            undefined
          : undefined,
      );
    void austinLoc;
    const locs = await pool.query(`SELECT id FROM locations WHERE franchisee_id = $1`, [
      ids.austinId,
    ]);
    const austinLocId = (locs.rows[0] as { id: string }).id;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Should Fail', locationId: austinLocId }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TARGET');
  });
});
