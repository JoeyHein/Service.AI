/**
 * Distance Matrix pluggable adapter (phase_ai_dispatcher).
 *
 * The dispatcher agent uses `computeTravelTime` to decide
 * whether a proposed assignment fits in the gap between a
 * tech's prior job and the next slot. The real impl wraps
 * Google Distance Matrix; the stub computes a haversine
 * distance between coordinates and uses a 35 mph fallback
 * speed — deterministic, fast, and good enough for tests + dev
 * travel-budget invariant checks.
 *
 * `resolveDistanceMatrixClient()` upgrades to the real impl when
 * `GOOGLE_MAPS_API_KEY` is set; missing key → stub with a WARN
 * log (never crashes on boot).
 */

import { logger } from './logger.js';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface TravelEstimate {
  /** Seconds. */
  durationSeconds: number;
  /** Metres. */
  distanceMeters: number;
  mode: 'driving';
  /** 'stub' or 'google' so log triage sees where the number came from. */
  provider: 'stub' | 'google';
}

export interface DistanceMatrixClient {
  estimate(origin: LatLng, dest: LatLng): Promise<TravelEstimate>;
}

// ---------------------------------------------------------------------------
// Stub
// ---------------------------------------------------------------------------

const EARTH_RADIUS_M = 6_371_000;
// 35 mph ≈ 15.65 m/s. Used as the fallback speed in the stub
// so a 10-mile hop is ~17 minutes — a reasonable default for
// the pilot territories.
const STUB_SPEED_MPS = 15.65;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Haversine distance in metres. Deterministic — same inputs
 * always produce the same output, which matters for the
 * scheduling tests that assert travel-budget behaviour.
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

export const stubDistanceMatrixClient: DistanceMatrixClient = {
  async estimate(origin, dest) {
    const distanceMeters = haversineMeters(origin, dest);
    const durationSeconds = Math.max(60, Math.round(distanceMeters / STUB_SPEED_MPS));
    return { durationSeconds, distanceMeters, mode: 'driving', provider: 'stub' };
  },
};

// ---------------------------------------------------------------------------
// Real (Google)
// ---------------------------------------------------------------------------

interface GoogleOpts {
  apiKey: string;
}

/**
 * Google Distance Matrix adapter. Uses fetch rather than the
 * Google SDK — the endpoint is a single URL that returns JSON,
 * and the direct call sidesteps a heavy transitive dependency
 * graph. The key is appended as a query parameter so referrer
 * restrictions on the Google Cloud key still work when we call
 * from the server.
 *
 * Errors fall back to the stub silently with a WARN log so a
 * Google outage does not black-hole the dispatcher.
 */
export function googleDistanceMatrixClient(
  opts: GoogleOpts,
): DistanceMatrixClient {
  return {
    async estimate(origin, dest) {
      try {
        const url = new URL(
          'https://maps.googleapis.com/maps/api/distancematrix/json',
        );
        url.searchParams.set('origins', `${origin.lat},${origin.lng}`);
        url.searchParams.set('destinations', `${dest.lat},${dest.lng}`);
        url.searchParams.set('mode', 'driving');
        url.searchParams.set('units', 'metric');
        url.searchParams.set('key', opts.apiKey);
        const res = await fetch(url.toString());
        if (!res.ok) throw new Error(`Distance Matrix ${res.status}`);
        const body = (await res.json()) as {
          rows?: Array<{
            elements?: Array<{
              status?: string;
              duration?: { value?: number };
              distance?: { value?: number };
            }>;
          }>;
        };
        const el = body.rows?.[0]?.elements?.[0];
        if (!el || el.status !== 'OK') {
          throw new Error(`Distance Matrix element ${el?.status ?? 'missing'}`);
        }
        return {
          durationSeconds: el.duration?.value ?? 0,
          distanceMeters: el.distance?.value ?? 0,
          mode: 'driving',
          provider: 'google',
        };
      } catch (err) {
        logger.warn(
          { err, origin, dest },
          'DistanceMatrix google call failed; falling back to stub',
        );
        return stubDistanceMatrixClient.estimate(origin, dest);
      }
    },
  };
}

export function resolveDistanceMatrixClient(): DistanceMatrixClient {
  const key = process.env['GOOGLE_MAPS_API_KEY'];
  if (!key) return stubDistanceMatrixClient;
  return googleDistanceMatrixClient({ apiKey: key });
}
