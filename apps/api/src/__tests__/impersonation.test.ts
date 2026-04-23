/**
 * Tests for TASK-TEN-04: X-Impersonate-Franchisee validation + audit writes.
 *
 * Covers the full matrix from the phase gate:
 *   1. Non-franchisor-admin + header → 403 IMPERSONATION_FORBIDDEN
 *   2. Franchisor admin of A + franchisee of B → 403
 *   3. Franchisor admin + non-existent franchisee → 403
 *   4. Franchisor admin + valid franchisee → 200, scope narrowed, audit written
 *   5. Missing header + franchisor admin → normal franchisor scope, no audit
 *   6. Malformed header (non-UUID) → 403 IMPERSONATION_INVALID_TARGET
 *   7. franchiseeLookup not wired + header → 403 IMPERSONATION_DISABLED
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type {
  FranchiseeLookup,
  AuditLogEntry,
  AuditLogWriter,
  MembershipRow,
} from '../request-scope.js';

const FRANCHISOR_A = '11111111-1111-1111-1111-111111111111';
const FRANCHISOR_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FRANCHISEE_OF_A = '22222222-2222-2222-2222-222222222222';
const FRANCHISEE_OF_B = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const NONEXISTENT_FRANCHISEE = '99999999-9999-9999-9999-999999999999';

const mockDb = { query: async (): Promise<unknown> => ({ rows: [{ '?column?': 1 }] }) };
const mockRedis = { ping: async (): Promise<string> => 'PONG' };

function mockAuth(userId: string) {
  return {
    api: {
      getSession: async () => ({
        session: { id: 'sess_1' },
        user: { id: userId },
      }),
    },
    handler: async () => new Response('', { status: 200 }),
  } as unknown as import('@service-ai/auth').Auth;
}

function mockResolver(memberships: MembershipRow[]) {
  return { memberships: async () => memberships };
}

function mockLookup(mapping: Record<string, string>): FranchiseeLookup {
  return {
    async franchisorIdFor(franchiseeId) {
      return mapping[franchiseeId] ?? null;
    },
  };
}

function recordingAuditWriter() {
  const entries: AuditLogEntry[] = [];
  const writer: AuditLogWriter = {
    async write(entry) {
      entries.push(entry);
    },
  };
  return { writer, entries };
}

const franchisorAdminOfA: MembershipRow = {
  scopeType: 'franchisor',
  role: 'franchisor_admin',
  franchisorId: FRANCHISOR_A,
  franchiseeId: null,
  locationId: null,
};

const dispatcherOfA: MembershipRow = {
  scopeType: 'franchisee',
  role: 'dispatcher',
  franchisorId: FRANCHISOR_A,
  franchiseeId: FRANCHISEE_OF_A,
  locationId: null,
};

let app: FastifyInstance;
afterEach(async () => {
  if (app) await app.close();
});

describe('TASK-TEN-04 / X-Impersonate-Franchisee', () => {
  it('returns 403 when a non-admin sets the header', async () => {
    const { writer, entries } = recordingAuditWriter();
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth('user_dispatcher'),
      membershipResolver: mockResolver([dispatcherOfA]),
      franchiseeLookup: mockLookup({ [FRANCHISEE_OF_A]: FRANCHISOR_A }),
      auditWriter: writer,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { 'x-impersonate-franchisee': FRANCHISEE_OF_A },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code ?? res.json().code).toMatch(
      /IMPERSONATION_FORBIDDEN/,
    );
    expect(entries).toHaveLength(0);
  });

  it('returns 403 when a franchisor admin targets another franchisor\'s franchisee', async () => {
    const { writer, entries } = recordingAuditWriter();
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth('admin_of_A'),
      membershipResolver: mockResolver([franchisorAdminOfA]),
      franchiseeLookup: mockLookup({ [FRANCHISEE_OF_B]: FRANCHISOR_B }),
      auditWriter: writer,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { 'x-impersonate-franchisee': FRANCHISEE_OF_B },
    });

    expect(res.statusCode).toBe(403);
    expect(entries).toHaveLength(0);
  });

  it('returns 403 when the target franchisee does not exist', async () => {
    const { writer, entries } = recordingAuditWriter();
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth('admin_of_A'),
      membershipResolver: mockResolver([franchisorAdminOfA]),
      franchiseeLookup: mockLookup({ [FRANCHISEE_OF_A]: FRANCHISOR_A }),
      auditWriter: writer,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { 'x-impersonate-franchisee': NONEXISTENT_FRANCHISEE },
    });

    expect(res.statusCode).toBe(403);
    expect(entries).toHaveLength(0);
  });

  it('returns 403 for a malformed (non-UUID) header', async () => {
    const { writer } = recordingAuditWriter();
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth('admin_of_A'),
      membershipResolver: mockResolver([franchisorAdminOfA]),
      franchiseeLookup: mockLookup({}),
      auditWriter: writer,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { 'x-impersonate-franchisee': 'not-a-uuid' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when impersonation is not configured but header is set', async () => {
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth('admin_of_A'),
      membershipResolver: mockResolver([franchisorAdminOfA]),
      // franchiseeLookup intentionally omitted.
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { 'x-impersonate-franchisee': FRANCHISEE_OF_A },
    });

    expect(res.statusCode).toBe(403);
  });

  it('narrows scope to the target franchisee and writes an audit row on success', async () => {
    const { writer, entries } = recordingAuditWriter();
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth('admin_of_A'),
      membershipResolver: mockResolver([franchisorAdminOfA]),
      franchiseeLookup: mockLookup({ [FRANCHISEE_OF_A]: FRANCHISOR_A }),
      auditWriter: writer,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: {
        'x-impersonate-franchisee': FRANCHISEE_OF_A,
        'user-agent': 'vitest',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.scope.type).toBe('franchisee');
    expect(body.data.scope.franchisorId).toBe(FRANCHISOR_A);
    expect(body.data.scope.franchiseeId).toBe(FRANCHISEE_OF_A);
    expect(body.data.scope.role).toBe('franchisee_owner');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorUserId: 'admin_of_A',
      targetFranchiseeId: FRANCHISEE_OF_A,
      action: 'impersonate.request',
      scopeType: 'franchisee',
      scopeId: FRANCHISEE_OF_A,
      userAgent: 'vitest',
    });
    expect(entries[0]?.metadata).toMatchObject({
      method: 'GET',
      url: '/api/v1/me',
      actorFranchisorId: FRANCHISOR_A,
    });
  });

  it('accepts the serviceai.impersonate cookie as a header fallback', async () => {
    const { writer, entries } = recordingAuditWriter();
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth('admin_of_A'),
      membershipResolver: mockResolver([franchisorAdminOfA]),
      franchiseeLookup: mockLookup({ [FRANCHISEE_OF_A]: FRANCHISOR_A }),
      auditWriter: writer,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: {
        // Two cookies — ours plus noise — to prove the parser picks the
        // right one regardless of ordering.
        cookie: `other=value; serviceai.impersonate=${FRANCHISEE_OF_A}; more=also`,
      },
    });

    expect(res.statusCode).toBe(200);
    const scope = res.json().data.scope;
    expect(scope.type).toBe('franchisee');
    expect(scope.franchiseeId).toBe(FRANCHISEE_OF_A);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('impersonate.request');
  });

  it('prefers the X-Impersonate-Franchisee header over the cookie when both are set', async () => {
    const ALT_FRANCHISEE = 'aaaaaaaa-aaaa-4000-aaaa-aaaaaaaaaaaa';
    const { writer } = recordingAuditWriter();
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth('admin_of_A'),
      membershipResolver: mockResolver([franchisorAdminOfA]),
      franchiseeLookup: mockLookup({
        [FRANCHISEE_OF_A]: FRANCHISOR_A,
        [ALT_FRANCHISEE]: FRANCHISOR_A,
      }),
      auditWriter: writer,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: {
        'x-impersonate-franchisee': ALT_FRANCHISEE,
        cookie: `serviceai.impersonate=${FRANCHISEE_OF_A}`,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.scope.franchiseeId).toBe(ALT_FRANCHISEE);
  });

  it('surfaces targetFranchiseeName when FranchiseeLookup supplies nameFor', async () => {
    const lookup = {
      async franchisorIdFor() {
        return FRANCHISOR_A;
      },
      async nameFor() {
        return 'Denver Metro';
      },
    };
    const { writer } = recordingAuditWriter();
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth('admin_of_A'),
      membershipResolver: mockResolver([franchisorAdminOfA]),
      franchiseeLookup: lookup,
      auditWriter: writer,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { 'x-impersonate-franchisee': FRANCHISEE_OF_A },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.impersonating).toEqual({
      targetFranchiseeId: FRANCHISEE_OF_A,
      targetFranchiseeName: 'Denver Metro',
    });
  });

  it('passes through unchanged when no header is set', async () => {
    const { writer, entries } = recordingAuditWriter();
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth('admin_of_A'),
      membershipResolver: mockResolver([franchisorAdminOfA]),
      franchiseeLookup: mockLookup({ [FRANCHISEE_OF_A]: FRANCHISOR_A }),
      auditWriter: writer,
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/me' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.scope.type).toBe('franchisor');
    expect(entries).toHaveLength(0);
  });
});
