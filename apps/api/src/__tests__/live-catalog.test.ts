/**
 * Live Postgres tests for TASK-PB-02 HQ catalog API.
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
let ids: { franchisorId: string };
let cookies: {
  platform: string;
  franchisorAdmin: string;
  denverOwner: string;
  denverDispatcher: string;
};

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
  const email = 'catalog-fradmin@elevateddoors.test';
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD, name: 'Catalog Admin' }),
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
  ids = { franchisorId: seed.franchisorId };
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
    platform: await signIn('joey@opendc.ca'),
    franchisorAdmin: await createFranchisorAdmin(ids.franchisorId),
    denverOwner: await signIn('denver.owner@elevateddoors.test'),
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

describe('PB-02 / templates CRUD', () => {
  it('anonymous: 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/catalog/templates' });
    expect(res.statusCode).toBe(401);
  });

  it('franchisor_admin creates → lists → updates → publishes → archives', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/catalog/templates',
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Summer 2026', slug: 'summer-2026' }),
    });
    expect(create.statusCode).toBe(201);
    const t = create.json().data;
    expect(t.status).toBe('draft');

    const update = await app.inject({
      method: 'PATCH',
      url: `/api/v1/catalog/templates/${t.id}`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Summer 2026 (v2)' }),
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().data.name).toBe('Summer 2026 (v2)');

    const publish = await app.inject({
      method: 'POST',
      url: `/api/v1/catalog/templates/${t.id}/publish`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(publish.statusCode).toBe(200);
    expect(publish.json().data.status).toBe('published');

    // Updating after publish should 409 TEMPLATE_NOT_EDITABLE.
    const lockedUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/catalog/templates/${t.id}`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'locked' }),
    });
    expect(lockedUpdate.statusCode).toBe(409);
    expect(lockedUpdate.json().error.code).toBe('TEMPLATE_NOT_EDITABLE');

    const archive = await app.inject({
      method: 'POST',
      url: `/api/v1/catalog/templates/${t.id}/archive`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().data.status).toBe('archived');
  });

  it('publishing a new template archives the previous published one atomically', async () => {
    const mk = async (slug: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/catalog/templates',
        headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: slug, slug }),
      });
      return res.json().data.id as string;
    };
    const t1 = await mk('atomic-one');
    await app.inject({
      method: 'POST',
      url: `/api/v1/catalog/templates/${t1}/publish`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    const t2 = await mk('atomic-two');
    await app.inject({
      method: 'POST',
      url: `/api/v1/catalog/templates/${t2}/publish`,
      headers: { cookie: cookies.franchisorAdmin },
    });

    // Only one published template should remain for this franchisor.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS c FROM service_catalog_templates
        WHERE franchisor_id = $1 AND status = 'published'`,
      [ids.franchisorId],
    );
    expect((rows[0] as { c: number }).c).toBe(1);
  });

  it('franchisee-scoped users get 403 CATALOG_READONLY on writes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/catalog/templates',
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'nope', slug: 'nope' }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CATALOG_READONLY');
  });

  it('platform admin can create a template by passing franchisorId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/catalog/templates',
      headers: { cookie: cookies.platform, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Platform-created',
        slug: 'platform-created',
        franchisorId: ids.franchisorId,
      }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.franchisorId).toBe(ids.franchisorId);
  });
});

describe('PB-02 / items CRUD', () => {
  let draftId: string;
  beforeEach(async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/catalog/templates',
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: `D-${Date.now()}`, slug: `d-${Date.now()}` }),
    });
    draftId = res.json().data.id as string;
  });

  it('create → list → update → delete', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/catalog/templates/${draftId}/items`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({
        sku: 'INST-2CAR',
        name: '2-car garage door install',
        category: 'Installs',
        unit: 'each',
        basePrice: 1800,
        floorPrice: 1500,
        ceilingPrice: 2200,
      }),
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().data.id as string;

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/templates/${draftId}/items`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(list.statusCode).toBe(200);
    const ids = (list.json().data as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(id);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/catalog/templates/${draftId}/items/${id}`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ basePrice: 1900 }),
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().data.basePrice).toBe('1900.00');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/catalog/templates/${draftId}/items/${id}`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(del.statusCode).toBe(200);
  });

  it('rejects floorPrice > ceilingPrice', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/catalog/templates/${draftId}/items`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({
        sku: 'BAD',
        name: 'bad',
        category: 'X',
        unit: 'each',
        basePrice: 100,
        floorPrice: 200,
        ceilingPrice: 150,
      }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('cannot add items to a published template', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/v1/catalog/templates/${draftId}/publish`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/catalog/templates/${draftId}/items`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({
        sku: 'LOCKED',
        name: 'locked',
        category: 'X',
        unit: 'each',
        basePrice: 100,
      }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TEMPLATE_NOT_EDITABLE');
  });

  it('franchisee-scoped users cannot write items either', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/catalog/templates/${draftId}/items`,
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: JSON.stringify({
        sku: 'NOPE',
        name: 'nope',
        category: 'X',
        unit: 'each',
        basePrice: 1,
      }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CATALOG_READONLY');
  });

  it('franchisee-scoped users CAN list items (read-only policy fires)', async () => {
    // Add an item as admin, then list as a dispatcher.
    await app.inject({
      method: 'POST',
      url: `/api/v1/catalog/templates/${draftId}/items`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({
        sku: 'READ-1',
        name: 'readable',
        category: 'X',
        unit: 'each',
        basePrice: 99,
      }),
    });
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/templates/${draftId}/items`,
      headers: { cookie: cookies.denverDispatcher },
    });
    expect(list.statusCode).toBe(200);
    const skus = (list.json().data as Array<{ sku: string }>).map((r) => r.sku);
    expect(skus).toContain('READ-1');
  });
});
