/**
 * Unit tests for the distance matrix stub (TASK-DI-02).
 */

import { describe, expect, it } from 'vitest';
import {
  stubDistanceMatrixClient,
  haversineMeters,
} from '../distance-matrix.js';

describe('DI-02 / haversineMeters', () => {
  it('zero distance between identical coordinates', () => {
    expect(haversineMeters({ lat: 39.74, lng: -104.99 }, { lat: 39.74, lng: -104.99 })).toBe(0);
  });

  it('~1.57 km between points 0.01° lat apart at Denver latitude', () => {
    const d = haversineMeters(
      { lat: 39.74, lng: -104.99 },
      { lat: 39.75, lng: -104.99 },
    );
    // A degree of latitude is ~111 km, so 0.01° ≈ 1.11 km.
    expect(d).toBeGreaterThan(1000);
    expect(d).toBeLessThan(1200);
  });

  it('determinism: same inputs → same output', () => {
    const a = haversineMeters({ lat: 1, lng: 2 }, { lat: 3, lng: 4 });
    const b = haversineMeters({ lat: 1, lng: 2 }, { lat: 3, lng: 4 });
    expect(a).toBe(b);
  });
});

describe('DI-02 / stubDistanceMatrixClient.estimate', () => {
  it('returns driving mode + stub provider', async () => {
    const e = await stubDistanceMatrixClient.estimate(
      { lat: 39.74, lng: -104.99 },
      { lat: 39.76, lng: -104.98 },
    );
    expect(e.provider).toBe('stub');
    expect(e.mode).toBe('driving');
  });

  it('minimum duration is 60s even on tiny distances', async () => {
    const e = await stubDistanceMatrixClient.estimate(
      { lat: 39.74, lng: -104.99 },
      { lat: 39.7401, lng: -104.99 },
    );
    expect(e.durationSeconds).toBeGreaterThanOrEqual(60);
  });

  it('~15 min for a 10 mi hop (within the stub speed profile)', async () => {
    // Move 0.15° of latitude ≈ 16.7 km ≈ 10.4 mi
    const e = await stubDistanceMatrixClient.estimate(
      { lat: 39.74, lng: -104.99 },
      { lat: 39.89, lng: -104.99 },
    );
    // 10 mi at 35 mph = ~17 min; assert within a sane band.
    expect(e.durationSeconds / 60).toBeGreaterThan(14);
    expect(e.durationSeconds / 60).toBeLessThan(22);
  });
});
