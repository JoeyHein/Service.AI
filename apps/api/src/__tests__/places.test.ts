import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { stubPlacesClient } from '../places.js';

const mockDb = { query: async () => ({ rows: [{ '?column?': 1 }] }) };
const mockRedis = { ping: async () => 'PONG' };

function mockAuth(userId: string | null) {
  return {
    api: {
      getSession: async () =>
        userId === null
          ? null
          : { session: { id: 's' }, user: { id: userId } },
    },
    handler: async () => new Response('', { status: 200 }),
  } as unknown as import('@service-ai/auth').Auth;
}

let app: FastifyInstance;
afterEach(async () => {
  if (app) await app.close();
});

describe('CJ-04 / stubPlacesClient', () => {
  it('returns a deterministic candidate set for any query (3 US + 2 CA)', async () => {
    const a = await stubPlacesClient.autocomplete('garage');
    const b = await stubPlacesClient.autocomplete('1600');
    expect(a).toHaveLength(5);
    expect(b).toHaveLength(5);
    expect(a.map((c) => c.placeId)).toEqual(b.map((c) => c.placeId));
  });

  it('details returns a full address for known placeIds, null otherwise', async () => {
    const d = await stubPlacesClient.details('stub-denver-a');
    expect(d?.city).toBe('Denver');
    expect(d?.state).toBe('CO');
    expect(d?.latitude).toBeCloseTo(39.7392, 3);
    const unknown = await stubPlacesClient.details('does-not-exist');
    expect(unknown).toBeNull();
  });
});

describe('CJ-04 / places routes', () => {
  it('autocomplete + details require an authenticated scope', async () => {
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth(null),
    });
    await app.ready();
    const auto = await app.inject({
      method: 'GET',
      url: '/api/v1/places/autocomplete?q=garage',
    });
    expect(auto.statusCode).toBe(401);
    const det = await app.inject({
      method: 'GET',
      url: '/api/v1/places/stub-denver-a',
    });
    expect(det.statusCode).toBe(401);
  });

  it('authenticated caller gets autocomplete + details', async () => {
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth('user_1'),
      membershipResolver: {
        memberships: async () => [
          {
            scopeType: 'franchisee',
            role: 'dispatcher',
            franchisorId: '11111111-1111-1111-1111-111111111111',
            franchiseeId: '22222222-2222-2222-2222-222222222222',
            locationId: null,
          },
        ],
      },
    });
    await app.ready();
    const auto = await app.inject({
      method: 'GET',
      url: '/api/v1/places/autocomplete?q=garage',
    });
    expect(auto.statusCode).toBe(200);
    expect(auto.json().data.candidates).toHaveLength(5);

    const det = await app.inject({
      method: 'GET',
      url: '/api/v1/places/stub-denver-a',
    });
    expect(det.statusCode).toBe(200);
    expect(det.json().data.city).toBe('Denver');
  });

  it('autocomplete returns empty list when query is too short', async () => {
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth('user_1'),
      membershipResolver: {
        memberships: async () => [
          {
            scopeType: 'franchisee',
            role: 'dispatcher',
            franchisorId: '11111111-1111-1111-1111-111111111111',
            franchiseeId: '22222222-2222-2222-2222-222222222222',
            locationId: null,
          },
        ],
      },
    });
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/places/autocomplete?q=a',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.candidates).toEqual([]);
  });

  it('details for an unknown placeId returns 404', async () => {
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth('user_1'),
      membershipResolver: {
        memberships: async () => [
          {
            scopeType: 'franchisee',
            role: 'dispatcher',
            franchisorId: '11111111-1111-1111-1111-111111111111',
            franchiseeId: '22222222-2222-2222-2222-222222222222',
            locationId: null,
          },
        ],
      },
    });
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/places/unknown-place',
    });
    expect(res.statusCode).toBe(404);
  });
});
