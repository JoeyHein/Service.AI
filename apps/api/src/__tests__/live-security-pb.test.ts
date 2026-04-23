/**
 * TASK-PB-06 — dedicated security suite for phase_pricebook.
 *
 * Uses the seeded catalog (Starter 2026) + Denver/Austin to exercise
 * every new endpoint against the threat model: anonymous 401,
 * cross-tenant reads/writes, franchisee write attempts on
 * catalog/items, role-based access, price boundary enforcement,
 * published-vs-draft status gates.
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
let ids: { franchisorId: string; denverId: string; austinId: string; templateId: string };
let cookies: {
  platform: string;
  franchisorAdmin: string;
  denverOwner: string;
  denverDispatcher: string;
  denverTech: string;
  austinOwner: string;
};
let itemInstallId: string;   // has floor 1500 / ceiling 2400 (seed: INST-2C-STEEL)
let itemLubeId: string;      // floor 8 / ceiling 20 (PART-LUBE)

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
  const email = 'pb-sec-fradmin@elevateddoors.test';
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD, name: 'PB Sec Admin' }),
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
    templateId: seed.catalog.templateId,
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
    platform: await signIn('joey@opendc.ca'),
    franchisorAdmin: await createFranchisorAdmin(ids.franchisorId),
    denverOwner: await signIn('denver.owner@elevateddoors.test'),
    denverDispatcher: await signIn('denver.dispatcher@elevateddoors.test'),
    denverTech: await signIn('denver.tech1@elevateddoors.test'),
    austinOwner: await signIn('austin.owner@elevateddoors.test'),
  };

  // Resolve SKU → id for the tests that need bound-check cases
  const itemRows = await pool.query(
    `SELECT sku, id FROM service_items WHERE sku IN ('INST-2C-STEEL','PART-LUBE')`,
  );
  for (const r of itemRows.rows as Array<{ sku: string; id: string }>) {
    if (r.sku === 'INST-2C-STEEL') itemInstallId = r.id;
    if (r.sku === 'PART-LUBE') itemLubeId = r.id;
  }
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('PB-06 / anonymous rejection on every new endpoint', () => {
  const endpoints: Array<{ method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; body?: object }> = [
    { method: 'GET', url: '/api/v1/catalog/templates' },
    { method: 'POST', url: '/api/v1/catalog/templates', body: { name: 'x', slug: 'x' } },
    { method: 'GET', url: '/api/v1/catalog/templates/00000000-0000-0000-0000-000000000000' },
    { method: 'PATCH', url: '/api/v1/catalog/templates/00000000-0000-0000-0000-000000000000', body: { name: 'x' } },
    { method: 'POST', url: '/api/v1/catalog/templates/00000000-0000-0000-0000-000000000000/publish', body: {} },
    { method: 'POST', url: '/api/v1/catalog/templates/00000000-0000-0000-0000-000000000000/archive', body: {} },
    { method: 'POST', url: '/api/v1/catalog/templates/00000000-0000-0000-0000-000000000000/items', body: { sku: 'x', name: 'x', category: 'X', unit: 'each', basePrice: 1 } },
    { method: 'GET', url: '/api/v1/catalog/templates/00000000-0000-0000-0000-000000000000/items' },
    { method: 'PATCH', url: '/api/v1/catalog/templates/00000000-0000-0000-0000-000000000000/items/00000000-0000-0000-0000-000000000000', body: { name: 'x' } },
    { method: 'DELETE', url: '/api/v1/catalog/templates/00000000-0000-0000-0000-000000000000/items/00000000-0000-0000-0000-000000000000' },
    { method: 'GET', url: '/api/v1/pricebook' },
    { method: 'POST', url: '/api/v1/pricebook/overrides', body: { serviceItemId: '00000000-0000-0000-0000-000000000000', overridePrice: 1 } },
    { method: 'DELETE', url: '/api/v1/pricebook/overrides/00000000-0000-0000-0000-000000000000' },
  ];

  for (const ep of endpoints) {
    it(`${ep.method} ${ep.url}`, async () => {
      const init: { method: typeof ep.method; url: string; headers?: Record<string, string>; payload?: string } = {
        method: ep.method,
        url: ep.url,
      };
      if (ep.body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.payload = JSON.stringify(ep.body);
      }
      const res = await app.inject(init);
      expect(res.statusCode).toBe(401);
    });
  }
});

describe('PB-06 / franchisee roles cannot write catalog/items', () => {
  type FranchiseeRoleKey = 'denverOwner' | 'denverDispatcher' | 'denverTech';
  const franchiseeRoles: Array<[string, FranchiseeRoleKey]> = [
    ['denver owner', 'denverOwner'],
    ['denver dispatcher', 'denverDispatcher'],
    ['denver tech', 'denverTech'],
  ];
  for (const [label, who] of franchiseeRoles) {
    it(`${label} POST /templates → 403 CATALOG_READONLY`, async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/catalog/templates',
        headers: { cookie: cookies[who], 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'nope', slug: `nope-${who}` }),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CATALOG_READONLY');
    });

    it(`${label} POST /items → 403`, async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/catalog/templates/${ids.templateId}/items`,
        headers: { cookie: cookies[who], 'content-type': 'application/json' },
        payload: JSON.stringify({
          sku: 'NOPE',
          name: 'x',
          category: 'X',
          unit: 'each',
          basePrice: 1,
        }),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CATALOG_READONLY');
    });

    it(`${label} POST /publish → 403`, async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/catalog/templates/${ids.templateId}/publish`,
        headers: { cookie: cookies[who] },
      });
      expect(res.statusCode).toBe(403);
    });
  }

  it('franchisee CAN read items (scoped_read policy)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/templates/${ids.templateId}/items`,
      headers: { cookie: cookies.denverDispatcher },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as unknown[];
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('PB-06 / resolved pricebook exposes published items only', () => {
  it('franchisee sees all 50 seeded items with base prices', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/pricebook',
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data.rows as Array<{ sku: string }>;
    expect(rows.length).toBe(50);
    expect(rows.map((r) => r.sku)).toContain('INST-2C-STEEL');
  });

  it('items in an archived template do not appear in the resolved view', async () => {
    // Archive the seeded template and confirm the pricebook drops to 0.
    const arc = await app.inject({
      method: 'POST',
      url: `/api/v1/catalog/templates/${ids.templateId}/archive`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(arc.statusCode).toBe(200);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/pricebook',
        headers: { cookie: cookies.denverOwner },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json().data.rows as unknown[]).length).toBe(0);
    } finally {
      // Un-archive for later tests by direct SQL (no un-archive endpoint
      // — archive is one-way). Tests that follow assume no published
      // template; we restore by publishing a fresh draft.
      await pool.query(
        `UPDATE service_catalog_templates SET status='published', archived_at=NULL
          WHERE id=$1`,
        [ids.templateId],
      );
    }
  });
});

describe('PB-06 / override price boundaries', () => {
  it('below floor → 400 PRICE_OUT_OF_BOUNDS', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/pricebook/overrides',
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ serviceItemId: itemInstallId, overridePrice: 500 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PRICE_OUT_OF_BOUNDS');
    expect(res.json().error.message).toMatch(/floor/);
  });

  it('above ceiling → 400 PRICE_OUT_OF_BOUNDS', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/pricebook/overrides',
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ serviceItemId: itemInstallId, overridePrice: 9999 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PRICE_OUT_OF_BOUNDS');
    expect(res.json().error.message).toMatch(/ceiling/);
  });

  it('exactly at floor is accepted; exactly at ceiling is accepted', async () => {
    const atFloor = await app.inject({
      method: 'POST',
      url: '/api/v1/pricebook/overrides',
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ serviceItemId: itemLubeId, overridePrice: 8 }),
    });
    expect([200, 201]).toContain(atFloor.statusCode);
    const atCeiling = await app.inject({
      method: 'POST',
      url: '/api/v1/pricebook/overrides',
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ serviceItemId: itemLubeId, overridePrice: 20 }),
    });
    expect([200, 201]).toContain(atCeiling.statusCode);
  });

  it('cross-franchisee override deletion → 404', async () => {
    // Seed has 2 Denver overrides — try to delete one as Austin.
    const { rows } = await pool.query(
      `SELECT id FROM pricebook_overrides WHERE franchisee_id = $1 LIMIT 1`,
      [ids.denverId],
    );
    const overrideId = (rows[0] as { id: string }).id;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/pricebook/overrides/${overrideId}`,
      headers: { cookie: cookies.austinOwner },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PB-06 / status gates', () => {
  let draftId: string;
  beforeEach(async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/catalog/templates',
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: `SecDraft-${Date.now()}`,
        slug: `sec-draft-${Date.now()}`,
      }),
    });
    draftId = res.json().data.id as string;
  });

  it('updating a published template → 409 TEMPLATE_NOT_EDITABLE', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/v1/catalog/templates/${draftId}/publish`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/catalog/templates/${draftId}`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'nope' }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TEMPLATE_NOT_EDITABLE');
  });

  it('re-publishing an archived template → 409 TEMPLATE_ARCHIVED', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/v1/catalog/templates/${draftId}/archive`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/catalog/templates/${draftId}/publish`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TEMPLATE_ARCHIVED');
  });
});
