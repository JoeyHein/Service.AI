/**
 * Google Places adapter (TASK-CJ-04).
 *
 * PlacesClient interface + two impls: stubPlacesClient (dev/test,
 * returns deterministic canned results) and googlePlacesClient (prod,
 * wraps @googlemaps/google-maps-services-js behind GOOGLE_MAPS_API_KEY).
 * Wiring follows the same pluggable pattern as MagicLinkSender and
 * ObjectStore so tests never hit the network.
 */
import type { FastifyInstance } from 'fastify';

export interface PlaceCandidate {
  placeId: string;
  description: string;
}

export interface PlaceDetails {
  placeId: string;
  formattedAddress: string;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface PlacesClient {
  autocomplete(query: string): Promise<PlaceCandidate[]>;
  details(placeId: string): Promise<PlaceDetails | null>;
}

/**
 * Deterministic three-result dev stub. Every query returns the same
 * three Colorado addresses so tests have stable assertions without
 * hitting Google's API.
 */
export const stubPlacesClient: PlacesClient = {
  async autocomplete(query) {
    const q = query.trim() || 'query';
    return [
      {
        placeId: 'stub-denver-a',
        description: `${q} — 1600 Pennsylvania Ave, Denver, CO`,
      },
      {
        placeId: 'stub-denver-b',
        description: `${q} — 800 N Logan St, Denver, CO`,
      },
      {
        placeId: 'stub-austin-a',
        description: `${q} — 500 Congress Ave, Austin, TX`,
      },
    ];
  },
  async details(placeId) {
    const map: Record<string, PlaceDetails> = {
      'stub-denver-a': {
        placeId: 'stub-denver-a',
        formattedAddress: '1600 Pennsylvania Ave, Denver, CO 80203',
        addressLine1: '1600 Pennsylvania Ave',
        city: 'Denver',
        state: 'CO',
        postalCode: '80203',
        country: 'USA',
        latitude: 39.7392,
        longitude: -104.9903,
      },
      'stub-denver-b': {
        placeId: 'stub-denver-b',
        formattedAddress: '800 N Logan St, Denver, CO 80203',
        addressLine1: '800 N Logan St',
        city: 'Denver',
        state: 'CO',
        postalCode: '80203',
        country: 'USA',
        latitude: 39.735,
        longitude: -104.979,
      },
      'stub-austin-a': {
        placeId: 'stub-austin-a',
        formattedAddress: '500 Congress Ave, Austin, TX 78701',
        addressLine1: '500 Congress Ave',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        country: 'USA',
        latitude: 30.265,
        longitude: -97.742,
      },
    };
    return map[placeId] ?? null;
  },
};

/**
 * Production impl. Deferred behind a dynamic import so the
 * @googlemaps/google-maps-services-js dep doesn't load (or fail) in
 * dev/test environments. Creating this client only when
 * GOOGLE_MAPS_API_KEY is set lets the app boot without the key.
 */
export async function googlePlacesClient(apiKey: string): Promise<PlacesClient> {
  const { Client } = await import('@googlemaps/google-maps-services-js');
  const client = new Client({});
  return {
    async autocomplete(query) {
      const res = await client.placeAutocomplete({
        params: { input: query, key: apiKey },
      });
      return res.data.predictions.map((p) => ({
        placeId: p.place_id,
        description: p.description,
      }));
    },
    async details(placeId) {
      const res = await client.placeDetails({
        params: {
          place_id: placeId,
          key: apiKey,
          fields: ['formatted_address', 'address_components', 'geometry'],
        },
      });
      const r = res.data.result;
      if (!r) return null;
      const comp = (type: string): string | null => {
        const c = r.address_components?.find((c) => c.types.includes(type as never));
        return c?.long_name ?? null;
      };
      return {
        placeId,
        formattedAddress: r.formatted_address ?? '',
        addressLine1: [comp('street_number'), comp('route')].filter(Boolean).join(' ') || null,
        city: comp('locality'),
        state: comp('administrative_area_level_1'),
        postalCode: comp('postal_code'),
        country: comp('country'),
        latitude: r.geometry?.location.lat ?? null,
        longitude: r.geometry?.location.lng ?? null,
      };
    },
  };
}

export function registerPlacesRoutes(app: FastifyInstance, client: PlacesClient): void {
  app.get('/api/v1/places/autocomplete', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const q = ((req.query as Record<string, string | undefined>)['q'] ?? '').trim();
    if (q.length < 2) {
      return reply
        .code(200)
        .send({ ok: true, data: { candidates: [] as PlaceCandidate[] } });
    }
    const candidates = await client.autocomplete(q);
    return reply.code(200).send({ ok: true, data: { candidates } });
  });

  app.get<{ Params: { placeId: string } }>(
    '/api/v1/places/:placeId',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      const details = await client.details(req.params.placeId);
      if (!details) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Place not found' },
        });
      }
      return reply.code(200).send({ ok: true, data: details });
    },
  );
}
