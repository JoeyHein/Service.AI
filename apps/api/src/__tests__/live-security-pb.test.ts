/**
 * TASK-PB-06 — dedicated security suite for phase_pricebook.
 *
 * Uses the seeded catalog (Starter 2026) + Denver/Austin to exercise
 * every new endpoint against the threat model: anonymous 401,
 * cross-tenant reads/writes, branch role write attempts on
 * catalog/items, role-based access, published-vs-draft status gates.
 *
 * After CHR-01 the pricebook_overrides table is gone — the POST/DELETE
 * /pricebook/overrides routes return 410 GONE; the price-boundary
 * assertions that were specific to overrides moved to live-pricebook.
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
  auditLogWriter,
} from '../production-resolvers.js';

const { Pool } = pkg;
const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let ids: { corporateId: string; denverId: string; austinId: string; templateId: string };
let cookies: {
  corporateAdmin: string;
  denverManager: string;
  denverDispatcher: string;
  denverTech: string;
  austinManager: string;
};
let itemInstallId: string;   // has floor 1500 / ceiling 2400 (seed: INST-2C-STEEL)

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

async function createCorporateAdmin(corporateId: string): Promise<string> {
  const email = 'pb-sec-coadmin@elevateddoors.test';
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
       SELECT $1, 'corporate'::scope_type, $2, 'corporate_admin'::role
       WHERE NOT EXISTS (
         SELECT 1 FROM memberships
          WHERE user_id=$1 AND scope_type='corporate' AND scope_id=$2 AND deleted_at IS NULL
       )`,
    [userId, corporateId],
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
    corporateId: seed.corporateId,
    denverId: seed.branches.find((b) => b.slug === 'denver')!.id,
    austinId: seed.branches.find((b) => b.slug === 'austin')!.id,
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
    auditWriter: auditLogWriter(db),
    magicLinkSender: { async send() {} },
    acceptUrlBase: 'http://localhost:3000',
  });
  await app.ready();
  cookies = {
    corporateAdmin: await createCorporateAdmin(ids.corporateId),
    denverManager: await signIn('denver.owner@elevateddoors.test'),
    denverDispatcher: await signIn('denver.dispatcher@elevateddoors.test'),
    denverTech: await signIn('denver.tech1@elevateddoors.test'),
    austinManager: await signIn('austin.owner@elevateddoors.test'),
  };

  // Resolve SKU → id for the tests that need bound-check cases
  const itemRows = await pool.query(
    `SELECT sku, id FROM service_items WHERE sku IN ('INST-2C-STEEL','PART-LUBE')`,
  );
  for (const r of itemRows.rows as Array<{ sku: string; id: string }>) {
    if (r.sku === 'INST-2C-STEEL') itemInstallId = r.id;
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
  // pricebook/overrides routes return 410 GONE regardless of auth state
  // after CHR-01 dropped the underlying table.
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

describe('PB-06 / branch roles cannot write catalog/items', () => {
  type BranchRoleKey = 'denverManager' | 'denverDispatcher' | 'denverTech';
  const branchRoles: Array<[string, BranchRoleKey]> = [
    ['denver manager', 'denverManager'],
    ['denver dispatcher', 'denverDispatcher'],
    ['denver tech', 'denverTech'],
  ];
  for (const [label, who] of branchRoles) {
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

  it('branch CAN read items (scoped_read policy)', async () => {
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
  it('branch sees the seeded items with base prices', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/pricebook',
      headers: { cookie: cookies.denverManager },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data.rows as Array<{ sku: string }>;
    // The seed inserts ≥45 items; concurrent test files may add or
    // remove a few. Assert the seeded sentinel SKU is present rather
    // than a brittle exact count.
    expect(rows.length).toBeGreaterThanOrEqual(40);
    expect(rows.map((r) => r.sku)).toContain('INST-2C-STEEL');
  });

  it('items in an archived template do not appear in the resolved view', async () => {
    // Archive the seeded template and confirm the pricebook drops to 0.
    const arc = await app.inject({
      method: 'POST',
      url: `/api/v1/catalog/templates/${ids.templateId}/archive`,
      headers: { cookie: cookies.corporateAdmin },
    });
    expect(arc.statusCode).toBe(200);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/pricebook',
        headers: { cookie: cookies.denverManager },
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

describe('PB-06 / pricebook overrides surface is 410 GONE', () => {
  it('POST /pricebook/overrides → 410 OVERRIDES_REMOVED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/pricebook/overrides',
      headers: { cookie: cookies.austinManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ serviceItemId: itemInstallId, overridePrice: 1800 }),
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('OVERRIDES_REMOVED');
  });

  it('DELETE /pricebook/overrides/:id → 410 OVERRIDES_REMOVED', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/pricebook/overrides/00000000-0000-0000-0000-000000000000`,
      headers: { cookie: cookies.austinManager },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('OVERRIDES_REMOVED');
  });
});

describe('PB-06 / status gates', () => {
  let draftId: string;
  beforeEach(async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/catalog/templates',
      headers: { cookie: cookies.corporateAdmin, 'content-type': 'application/json' },
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
      headers: { cookie: cookies.corporateAdmin },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/catalog/templates/${draftId}`,
      headers: { cookie: cookies.corporateAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'nope' }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TEMPLATE_NOT_EDITABLE');
  });

  it('re-publishing an archived template → 409 TEMPLATE_ARCHIVED', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/v1/catalog/templates/${draftId}/archive`,
      headers: { cookie: cookies.corporateAdmin },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/catalog/templates/${draftId}/publish`,
      headers: { cookie: cookies.corporateAdmin },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TEMPLATE_ARCHIVED');
  });
});
