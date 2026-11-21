import { legacyHaversineDistance } from '@darmawanweb/ais-its-contracts/domain';
import { describe, expect, it } from 'vitest';

import { LEGACY_GOLDENS } from './__fixtures__/legacy-goldens.js';
import { classifyMovement, DEFAULT_DEDUP_MIN_DISTANCE_M } from './movement.js';

const t0 = Date.parse('2026-01-01T00:00:00.000Z');
const latest = { timeMs: t0, lat: -7.2, lon: 112.73 };

describe('legacy haversine (geo.haversine_distance, golden: legacy calculateDistance)', () => {
  it.each(LEGACY_GOLDENS.haversine.map((golden) => [golden.meters, golden]))(
    '%s m',
    (_meters, golden) => {
      const result = legacyHaversineDistance(golden.from, golden.to);
      expect(result.meters).toBe(golden.meters);
      expect(result.nm).toBe(golden.nm);
    },
  );
});

describe('classifyMovement (data.ais_ingest_rules)', () => {
  it('records the first report of a vessel', () => {
    expect(classifyMovement(null, latest)).toEqual({ kind: 'first' });
  });

  it('skips a newer report that moved less than 0.1 m from the LATEST position', () => {
    // 0.0992 m east (legacy golden pair 4).
    const report = { timeMs: t0 + 10_000, lat: -7.2, lon: 112.7300009 };
    const result = classifyMovement(latest, report);

    expect(result).toEqual({
      kind: 'stationary',
      distanceM: LEGACY_GOLDENS.haversine[3]?.meters,
    });
    expect(DEFAULT_DEDUP_MIN_DISTANCE_M).toBe(0.1);
  });

  it('records a newer report that moved at least the threshold', () => {
    const report = { timeMs: t0 + 10_000, lat: -7.25, lon: 112.8 };
    expect(classifyMovement(latest, report)).toMatchObject({
      kind: 'advance',
      distanceM: expect.closeTo(9509.41, 1) as number,
    });
    // A custom threshold.
    expect(classifyMovement(latest, report, 10_000).kind).toBe('stationary');
  });

  it('flags a report older than the latest as out of order', () => {
    expect(
      classifyMovement(latest, { timeMs: t0 - 1, lat: 0, lon: 0 }),
    ).toEqual({ kind: 'out_of_order' });
  });

  it('distinguishes a repeated report from a conflicting one at the same time', () => {
    expect(classifyMovement(latest, { ...latest })).toEqual({
      kind: 'same_time',
      samePosition: true,
      distanceM: 0,
    });
    expect(
      classifyMovement(latest, { timeMs: t0, lat: -7.21, lon: 112.73 }),
    ).toMatchObject({ kind: 'same_time', samePosition: false });
  });
});
