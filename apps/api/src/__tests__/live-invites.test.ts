/**
 * Live Postgres integration tests for TASK-TEN-05 invitation flow.
 *
 * Builds a real Drizzle handle + Better Auth instance against the docker
 * postgres, creates a franchisor_admin user via sign-up, and exercises the
 * full lifecycle:
 *   - POST /api/v1/invites → invite row + email delivered
 *   - GET  /api/v1/invites → lists the pending invite
 *   - GET  /api/v1/invites/accept/:token → public metadata
 *   - POST /api/v1/invites/accept/:token → membership created, invite
 *     redeemed, second accept returns 410 INVITE_USED
 *   - DELETE /api/v1/invites/:id → revokes; second call idempotent
 *   - accept on expired / revoked / wrong-email → correct error codes
 *
 * Auto-skips when DATABASE_URL is unreachable.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createAuth } from '@service-ai/auth';
import type { MagicLinkSender, MagicLinkPayload } from '@service-ai/auth';
import * as schema from '@service-ai/db';
import {
  users,
  sessions,
  accounts,
  verifications,
  memberships,
} from '@service-ai/db';
import { buildApp } from '../app.js';

const { Pool } = pkg;

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

const FRANCHISOR_ID = '99999999-9999-4000-9999-999999999999';
const FRANCHISEE_ID = '88888888-8888-4000-8888-888888888888';
const INVITER_EMAIL = 'live-invite-inviter@opendc.ca';
const INVITEE_EMAIL = 'live-invite-invitee@opendc.ca';
const OTHER_EMAIL = 'live-invite-other@opendc.ca';
const PASSWORD = 'changeme123!A';

let reachable = false;
let pool: InstanceType<typeof Pool>;

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

function normalizeSetCookie(sc: string | string[] | undefined): string {
  if (!sc) return '';
  return Array.isArray(sc) ? sc.join('\n') : sc;
}

function extractCookieHeader(setCookieStr: string): string | null {
  const firstLine = setCookieStr.split('\n')[0];
  if (!firstLine) return null;
  const match = firstLine.match(/^([^=]+=[^;]+)/);
  return match ? match[1]! : null;
}

function recordingSender() {
  const sent: MagicLinkPayload[] = [];
  const sender: MagicLinkSender = {
    async send(payload) {
      sent.push(payload);
    },
  };
  return { sender, sent };
}

async function createUserWithSession(
  app: FastifyInstance,
  email: string,
): Promise<{ userId: string; cookie: string }> {
  const signup = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: PASSWORD, name: email }),
  });
  expect(signup.statusCode).toBe(200);

  const signin = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(signin.statusCode).toBe(200);
  const cookie = extractCookieHeader(normalizeSetCookie(signin.headers['set-cookie']));
  expect(cookie).toBeTruthy();

  const [u] = await drizzle(pool, { schema })
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  return { userId: u!.id, cookie: cookie! };
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });

  // Ensure rls_test_user has permissions on the invitations table for other
  // suites that may run afterwards (the live-rls beforeAll grants on ALL
  // TABLES which covers anything that already exists at grant time).
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rls_test_user') THEN
        CREATE ROLE rls_test_user NOSUPERUSER NOBYPASSRLS LOGIN PASSWORD 'rls_test_user';
      END IF;
    END
    $$;
  `);
  await pool.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_test_user',
  );
});

afterAll(async () => {
  if (pool) await pool.end();
});

let app: FastifyInstance;

async function resetState() {
  // Wipe test rows in reverse FK order. We key off deterministic emails so
  // concurrent runs from other suites are not disturbed.
  await pool.query(`DELETE FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email IN ($1,$2,$3))`, [
    INVITER_EMAIL,
    INVITEE_EMAIL,
    OTHER_EMAIL,
  ]);
  await pool.query(`DELETE FROM invitations WHERE email IN ($1,$2,$3)`, [
    INVITER_EMAIL,
    INVITEE_EMAIL,
    OTHER_EMAIL,
  ]);
  await pool.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email IN ($1,$2,$3))`, [
    INVITER_EMAIL,
    INVITEE_EMAIL,
    OTHER_EMAIL,
  ]);
  await pool.query(`DELETE FROM accounts WHERE user_id IN (SELECT id FROM users WHERE email IN ($1,$2,$3))`, [
    INVITER_EMAIL,
    INVITEE_EMAIL,
    OTHER_EMAIL,
  ]);
  await pool.query(`DELETE FROM users WHERE email IN ($1,$2,$3)`, [
    INVITER_EMAIL,
    INVITEE_EMAIL,
    OTHER_EMAIL,
  ]);
  await pool.query('DELETE FROM franchisees WHERE id = $1', [FRANCHISEE_ID]);
  await pool.query('DELETE FROM franchisors WHERE id = $1', [FRANCHISOR_ID]);

  await pool.query(
    `INSERT INTO franchisors (id, name, slug) VALUES ($1, 'Live Invite Franchisor', 'live-invite-fr')`,
    [FRANCHISOR_ID],
  );
  await pool.query(
    `INSERT INTO franchisees (id, franchisor_id, name, slug) VALUES ($1, $2, 'Live Invite Franchisee', 'live-invite-fe')`,
    [FRANCHISEE_ID, FRANCHISOR_ID],
  );
}

async function buildLiveApp() {
  const db = drizzle(pool, { schema });
  const auth = createAuth({
    db,
    authSchema: { user: users, session: sessions, account: accounts, verification: verifications },
    baseUrl: 'http://localhost',
    secret: 'x'.repeat(32),
  });
  const { sender, sent } = recordingSender();
  app = buildApp({
    db: { query: async () => ({ rows: [] }) },
    redis: { ping: async () => 'PONG' },
    logger: false,
    auth,
    drizzle: db,
    magicLinkSender: sender,
    acceptUrlBase: 'http://localhost:3000',
    // Resolve every member to a franchisor_admin of FRANCHISOR_ID so we can
    // exercise the create path without having to pre-insert memberships.
    membershipResolver: {
      async memberships() {
        return [
          {
            scopeType: 'franchisor',
            role: 'franchisor_admin',
            franchisorId: FRANCHISOR_ID,
            franchiseeId: null,
            locationId: null,
          },
        ];
      },
    },
  });
  await app.ready();
  return { app, sent };
}

beforeEach(async (ctx) => {
  if (!reachable) return ctx.skip();
  await resetState();
});

afterEach(async () => {
  if (app) await app.close();
});

describe('Invitation flow end-to-end (live Postgres)', () => {
  it('create → list → accept GET → accept POST creates a membership', async () => {
    const { app, sent } = await buildLiveApp();
    const { cookie: inviterCookie } = await createUserWithSession(app, INVITER_EMAIL);

    // Create invite
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: { cookie: inviterCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: INVITEE_EMAIL,
        role: 'dispatcher',
        scopeType: 'franchisee',
        franchiseeId: FRANCHISEE_ID,
      }),
    });
    expect(create.statusCode).toBe(201);
    const { acceptUrl } = create.json().data;
    expect(acceptUrl).toMatch(/\/accept-invite\/[A-Za-z0-9_-]{43}$/);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.email).toBe(INVITEE_EMAIL);
    expect(sent[0]?.purpose).toBe('invite');

    // List: the inviter should see one pending invite
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/invites',
      headers: { cookie: inviterCookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);

    // Public accept GET with the raw token from the URL
    const token = acceptUrl.split('/').pop()!;
    const getAccept = await app.inject({
      method: 'GET',
      url: `/api/v1/invites/accept/${token}`,
    });
    expect(getAccept.statusCode).toBe(200);
    expect(getAccept.json().data).toMatchObject({
      email: INVITEE_EMAIL,
      role: 'dispatcher',
      scopeType: 'franchisee',
    });

    // Sign up the invitee and redeem
    const { cookie: inviteeCookie, userId: inviteeId } = await createUserWithSession(
      app,
      INVITEE_EMAIL,
    );
    const postAccept = await app.inject({
      method: 'POST',
      url: `/api/v1/invites/accept/${token}`,
      headers: { cookie: inviteeCookie },
    });
    expect(postAccept.statusCode).toBe(200);
    const body = postAccept.json();
    expect(body.data.role).toBe('dispatcher');

    // Membership row exists
    const db = drizzle(pool, { schema });
    const m = await db.select().from(memberships).where(eq(memberships.userId, inviteeId));
    expect(m).toHaveLength(1);
    expect(m[0]?.franchiseeId).toBe(FRANCHISEE_ID);
    expect(m[0]?.role).toBe('dispatcher');

    // Second accept: INVITE_USED
    const reAccept = await app.inject({
      method: 'POST',
      url: `/api/v1/invites/accept/${token}`,
      headers: { cookie: inviteeCookie },
    });
    expect(reAccept.statusCode).toBe(410);
    expect(reAccept.json().error.code).toBe('INVITE_USED');
  });

  it('revoke is idempotent — second DELETE returns alreadyRevoked:true', async () => {
    const { app } = await buildLiveApp();
    const { cookie: inviterCookie } = await createUserWithSession(app, INVITER_EMAIL);
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: { cookie: inviterCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: INVITEE_EMAIL,
        role: 'dispatcher',
        scopeType: 'franchisee',
        franchiseeId: FRANCHISEE_ID,
      }),
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().data.id;

    const del1 = await app.inject({
      method: 'DELETE',
      url: `/api/v1/invites/${id}`,
      headers: { cookie: inviterCookie },
    });
    expect(del1.statusCode).toBe(200);
    expect(del1.json().data).toEqual({ revoked: true, alreadyRevoked: false });

    const del2 = await app.inject({
      method: 'DELETE',
      url: `/api/v1/invites/${id}`,
      headers: { cookie: inviterCookie },
    });
    expect(del2.statusCode).toBe(200);
    expect(del2.json().data).toEqual({ revoked: false, alreadyRevoked: true });
  });

  it('revoked invite cannot be accepted (410 INVITE_REVOKED)', async () => {
    const { app } = await buildLiveApp();
    const { cookie: inviterCookie } = await createUserWithSession(app, INVITER_EMAIL);
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: { cookie: inviterCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: INVITEE_EMAIL,
        role: 'dispatcher',
        scopeType: 'franchisee',
        franchiseeId: FRANCHISEE_ID,
      }),
    });
    const { id, acceptUrl } = create.json().data;
    const token = acceptUrl.split('/').pop()!;

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/invites/${id}`,
      headers: { cookie: inviterCookie },
    });

    const getRes = await app.inject({ method: 'GET', url: `/api/v1/invites/accept/${token}` });
    expect(getRes.statusCode).toBe(410);
    expect(getRes.json().error.code).toBe('INVITE_REVOKED');
  });

  it('expired invite returns 410 INVITE_EXPIRED', async () => {
    const { app } = await buildLiveApp();
    const { cookie: inviterCookie } = await createUserWithSession(app, INVITER_EMAIL);
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: { cookie: inviterCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: INVITEE_EMAIL,
        role: 'dispatcher',
        scopeType: 'franchisee',
        franchiseeId: FRANCHISEE_ID,
      }),
    });
    const { acceptUrl } = create.json().data;
    const token = acceptUrl.split('/').pop()!;

    // Age it 73h into the past by direct DB update (admin-pool, bypasses RLS).
    await pool.query(
      `UPDATE invitations SET expires_at = now() - interval '1 hour' WHERE token_hash = $1`,
      [createHash('sha256').update(token).digest('hex')],
    );

    const getRes = await app.inject({ method: 'GET', url: `/api/v1/invites/accept/${token}` });
    expect(getRes.statusCode).toBe(410);
    expect(getRes.json().error.code).toBe('INVITE_EXPIRED');
  });

  it('accept POST rejects EMAIL_MISMATCH when authed email differs', async () => {
    const { app } = await buildLiveApp();
    const { cookie: inviterCookie } = await createUserWithSession(app, INVITER_EMAIL);
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: { cookie: inviterCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: INVITEE_EMAIL,
        role: 'dispatcher',
        scopeType: 'franchisee',
        franchiseeId: FRANCHISEE_ID,
      }),
    });
    const token = (create.json().data.acceptUrl as string).split('/').pop()!;

    const { cookie: otherCookie } = await createUserWithSession(app, OTHER_EMAIL);
    const postAccept = await app.inject({
      method: 'POST',
      url: `/api/v1/invites/accept/${token}`,
      headers: { cookie: otherCookie },
    });
    expect(postAccept.statusCode).toBe(403);
    expect(postAccept.json().error.code).toBe('EMAIL_MISMATCH');
  });

  it('create invite for role outside matrix returns 403 ROLE_NOT_INVITABLE', async () => {
    const { app } = await buildLiveApp();
    const { cookie: inviterCookie } = await createUserWithSession(app, INVITER_EMAIL);

    // franchisor_admin inviting a franchisee at a franchisee that does not
    // belong to their franchisor should be rejected.
    const otherFranchisorId = '77777777-7777-4000-7777-777777777777';
    const otherFranchiseeId = '66666666-6666-4000-6666-666666666666';
    await pool.query(
      `INSERT INTO franchisors (id, name, slug) VALUES ($1, 'Other', 'live-invite-other') ON CONFLICT DO NOTHING`,
      [otherFranchisorId],
    );
    await pool.query(
      `INSERT INTO franchisees (id, franchisor_id, name, slug) VALUES ($1, $2, 'Other Fe', 'live-invite-other-fe') ON CONFLICT DO NOTHING`,
      [otherFranchiseeId, otherFranchisorId],
    );

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: { cookie: inviterCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: INVITEE_EMAIL,
        role: 'dispatcher',
        scopeType: 'franchisee',
        franchiseeId: otherFranchiseeId,
      }),
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().error.code).toBe('ROLE_NOT_INVITABLE');

    await pool.query('DELETE FROM franchisees WHERE id = $1', [otherFranchiseeId]);
    await pool.query('DELETE FROM franchisors WHERE id = $1', [otherFranchisorId]);
  });
});

