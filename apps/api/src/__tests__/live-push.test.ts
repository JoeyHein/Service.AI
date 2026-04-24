/**
 * Live Postgres tests for TASK-TM-06 push subscribe endpoints.
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
let cookies: { tech1: string; tech2: string };

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
    tech1: await signIn('denver.tech1@elevateddoors.test'),
    tech2: await signIn('denver.tech2@elevateddoors.test'),
  };
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

const baseSub = {
  endpoint: 'https://fcm.googleapis.com/wp/endpoint-1',
  keys: { p256dh: 'key-p256', auth: 'key-auth' },
  userAgent: 'Chrome/Android test',
};

describe('TM-06 / push subscribe + unsubscribe', () => {
  it('anonymous: 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(baseSub),
    });
    expect(res.statusCode).toBe(401);
  });

  it('subscribes; duplicate same-user same-endpoint updates instead of inserting', async () => {
    const sub = {
      ...baseSub,
      endpoint: 'https://fcm.googleapis.com/wp/endpoint-dup',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { cookie: cookies.tech1, 'content-type': 'application/json' },
      payload: JSON.stringify(sub),
    });
    expect(first.statusCode).toBe(201);
    const id1 = first.json().data.id as string;

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { cookie: cookies.tech1, 'content-type': 'application/json' },
      payload: JSON.stringify({ ...sub, userAgent: 'Updated UA' }),
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().data.id).toBe(id1);
    expect(second.json().data.userAgent).toBe('Updated UA');
  });

  it('endpoint collision between two users soft-deletes the old owner', async () => {
    const sub = {
      ...baseSub,
      endpoint: 'https://fcm.googleapis.com/wp/endpoint-move',
    };
    const one = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { cookie: cookies.tech1, 'content-type': 'application/json' },
      payload: JSON.stringify(sub),
    });
    expect(one.statusCode).toBe(201);
    const id1 = one.json().data.id as string;

    const two = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { cookie: cookies.tech2, 'content-type': 'application/json' },
      payload: JSON.stringify(sub),
    });
    expect(two.statusCode).toBe(201);
    const id2 = two.json().data.id as string;
    expect(id2).not.toBe(id1);

    const { rows } = await pool.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM push_subscriptions WHERE id = $1`,
      [id1],
    );
    expect(rows[0]?.deleted_at).not.toBeNull();
  });

  it('DELETE by id only succeeds for the owning user', async () => {
    const sub = {
      ...baseSub,
      endpoint: 'https://fcm.googleapis.com/wp/endpoint-delete',
    };
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { cookie: cookies.tech1, 'content-type': 'application/json' },
      payload: JSON.stringify(sub),
    });
    const id = create.json().data.id as string;

    // tech2 can't delete tech1's subscription → 404 (not 403, by policy)
    const byOther = await app.inject({
      method: 'DELETE',
      url: `/api/v1/push/subscriptions/${id}`,
      headers: { cookie: cookies.tech2 },
    });
    expect(byOther.statusCode).toBe(404);

    const byOwner = await app.inject({
      method: 'DELETE',
      url: `/api/v1/push/subscriptions/${id}`,
      headers: { cookie: cookies.tech1 },
    });
    expect(byOwner.statusCode).toBe(200);
    expect(byOwner.json().data.deleted).toBe(true);
  });

  it('DELETE by endpoint revokes the caller\'s own subscription', async () => {
    const sub = {
      ...baseSub,
      endpoint: 'https://fcm.googleapis.com/wp/endpoint-unsub-by-url',
    };
    await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { cookie: cookies.tech1, 'content-type': 'application/json' },
      payload: JSON.stringify(sub),
    });
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/v1/push/subscribe',
      headers: { cookie: cookies.tech1, 'content-type': 'application/json' },
      payload: JSON.stringify({ endpoint: sub.endpoint }),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().data.deleted).toBe(true);
  });

  it('DELETE by endpoint for a subscription owned by another user → 404', async () => {
    const sub = {
      ...baseSub,
      endpoint: 'https://fcm.googleapis.com/wp/endpoint-cross',
    };
    await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { cookie: cookies.tech1, 'content-type': 'application/json' },
      payload: JSON.stringify(sub),
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/push/subscribe',
      headers: { cookie: cookies.tech2, 'content-type': 'application/json' },
      payload: JSON.stringify({ endpoint: sub.endpoint }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects malformed endpoint with 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { cookie: cookies.tech1, 'content-type': 'application/json' },
      payload: JSON.stringify({ ...baseSub, endpoint: 'not a url' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});
