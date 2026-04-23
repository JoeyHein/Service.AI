/**
 * Live Postgres tests for TASK-PB-03 franchisee pricebook + overrides.
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

const { Pool } = pkg;
const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let ids: { franchisorId: string; denverId: string; austinId: string };
let cookies: {
  denverOwner: string;
  denverDispatcher: string;
  austinOwner: string;
  franchisorAdmin: string;
};
let templateId: string;
let itemIdPrimary: string;   // has floor 1500 / ceiling 2200
let itemIdOpen: string;       // no floor / ceiling

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

async function createFranchisorAdmin(franchisorId: string): Promise<string> {
  const email = 'pricebook-fradmin@elevateddoors.test';
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD, name: 'PB Admin' }),
  });
  const db = drizzle(pool, { schema });
  const [{ id: userId }] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  await pool.query(
    `INSERT INTO memberships (user_id, scope_type, scope_id, role)
       SELECT $1, 'franchisor'::scope_type, $2, 'franchisor_admin'::role
       WHERE NOT EXISTS (
         SELECT 1 FROM memberships
          WHERE user_id=$1 AND scope_type='franchisor' AND scope_id=$2 AND deleted_at IS NULL
       )`,
    [userId, franchisorId],
  );
  return await signIn(email);
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
    denverDispatcher: await signIn('denver.dispatcher@elevateddoors.test'),
    austinOwner: await signIn('austin.owner@elevateddoors.test'),
    franchisorAdmin: await createFranchisorAdmin(ids.franchisorId),
  };

  // Build a template with two items and publish it.
  const tRes = await app.inject({
    method: 'POST',
    url: '/api/v1/catalog/templates',
    headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'PB Test', slug: 'pb-test' }),
  });
  templateId = tRes.json().data.id as string;
  const i1 = await app.inject({
    method: 'POST',
    url: `/api/v1/catalog/templates/${templateId}/items`,
    headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
    payload: JSON.stringify({
      sku: 'PB-INST',
      name: 'Install',
      category: 'Installs',
      unit: 'each',
      basePrice: 1800,
      floorPrice: 1500,
      ceilingPrice: 2200,
    }),
  });
  itemIdPrimary = i1.json().data.id as string;
  const i2 = await app.inject({
    method: 'POST',
    url: `/api/v1/catalog/templates/${templateId}/items`,
    headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
    payload: JSON.stringify({
      sku: 'PB-OPEN',
      name: 'Free spec',
      category: 'Parts',
      unit: 'each',
      basePrice: 50,
    }),
  });
  itemIdOpen = i2.json().data.id as string;
  await app.inject({
    method: 'POST',
    url: `/api/v1/catalog/templates/${templateId}/publish`,
    headers: { cookie: cookies.franchisorAdmin },
  });
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('PB-03 / resolved pricebook', () => {
  it('anonymous: 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/pricebook' });
    expect(res.statusCode).toBe(401);
  });

  it('franchisee sees both items with effectivePrice = basePrice before any override', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/pricebook',
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data.rows as Array<{
      sku: string;
      basePrice: string;
      effectivePrice: string;
      overridden: boolean;
    }>;
    const byS = Object.fromEntries(rows.map((r) => [r.sku, r]));
    expect(byS['PB-INST']?.effectivePrice).toBe('1800.00');
    expect(byS['PB-INST']?.overridden).toBe(false);
    expect(byS['PB-OPEN']?.effectivePrice).toBe('50.00');
  });

  it('override within [floor, ceiling] is accepted and reflected in the resolved view', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/pricebook/overrides',
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        serviceItemId: itemIdPrimary,
        overridePrice: 2000,
        note: 'Denver premium',
      }),
    });
    expect(create.statusCode).toBe(201);

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/pricebook',
      headers: { cookie: cookies.denverOwner },
    });
    const rows = after.json().data.rows as Array<{
      sku: string;
      effectivePrice: string;
      overridePrice: string | null;
      overridden: boolean;
    }>;
    const inst = rows.find((r) => r.sku === 'PB-INST')!;
    expect(inst.overridden).toBe(true);
    expect(inst.effectivePrice).toBe('2000.00');
    expect(inst.overridePrice).toBe('2000.00');
  });

  it('re-POSTing an override for the same item upserts in place (one active per item)', async () => {
    const a = await app.inject({
      method: 'POST',
      url: '/api/v1/pricebook/overrides',
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ serviceItemId: itemIdPrimary, overridePrice: 1900 }),
    });
    expect(a.statusCode).toBe(200); // updated

    const { rows } = await pool.query(
      `SELECT count(*)::int AS c FROM pricebook_overrides
        WHERE franchisee_id = $1 AND service_item_id = $2 AND deleted_at IS NULL`,
      [ids.denverId, itemIdPrimary],
    );
    expect((rows[0] as { c: number }).c).toBe(1);
  });

  it('below floor → 400 PRICE_OUT_OF_BOUNDS', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/pricebook/overrides',
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ serviceItemId: itemIdPrimary, overridePrice: 1400 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PRICE_OUT_OF_BOUNDS');
    expect(res.json().error.message).toContain('floor');
  });

  it('above ceiling → 400 PRICE_OUT_OF_BOUNDS', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/pricebook/overrides',
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ serviceItemId: itemIdPrimary, overridePrice: 9999 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PRICE_OUT_OF_BOUNDS');
    expect(res.json().error.message).toContain('ceiling');
  });

  it('item with no floor/ceiling accepts any non-negative price', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/pricebook/overrides',
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ serviceItemId: itemIdOpen, overridePrice: 1 }),
    });
    expect([200, 201]).toContain(res.statusCode);
  });

  it('DELETE removes the override; resolved view reverts to base', async () => {
    // Clean setup: ensure there's an override
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/pricebook/overrides',
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ serviceItemId: itemIdOpen, overridePrice: 77 }),
    });
    const overrideId = create.json().data.id as string;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/pricebook/overrides/${overrideId}`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().data.deleted).toBe(true);

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/pricebook',
      headers: { cookie: cookies.denverOwner },
    });
    const open = (after.json().data.rows as Array<{ sku: string; overridden: boolean; effectivePrice: string }>).find(
      (r) => r.sku === 'PB-OPEN',
    )!;
    expect(open.overridden).toBe(false);
    expect(open.effectivePrice).toBe('50.00');
  });

  it('cross-franchisee override write: overriding an item from another franchisor → 400 INVALID_TARGET', async () => {
    // We don't have a second franchisor seeded; simulate by trying to
    // override a UUID that isn't an item at all. resolveTarget will
    // still map austin → their franchisor, but the item lookup fails.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/pricebook/overrides',
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        serviceItemId: '00000000-0000-0000-0000-000000000000',
        overridePrice: 1,
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TARGET');
  });

  it('deleting another franchisee\'s override returns 404', async () => {
    // Create as Denver, try to delete as Austin
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/pricebook/overrides',
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ serviceItemId: itemIdOpen, overridePrice: 42 }),
    });
    const overrideId = create.json().data.id as string;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/pricebook/overrides/${overrideId}`,
      headers: { cookie: cookies.austinOwner },
    });
    expect(del.statusCode).toBe(404);
  });
});
