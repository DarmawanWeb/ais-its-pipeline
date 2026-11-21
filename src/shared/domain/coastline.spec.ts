import { readFileSync } from 'node:fs';

import { distance } from '@turf/distance';
import { point } from '@turf/helpers';
import { nearestPointOnLine } from '@turf/nearest-point-on-line';
import { describe, expect, it } from 'vitest';

import { LEGACY_GOLDENS } from './__fixtures__/legacy-goldens.js';
import { CoastlineFormatError, CoastlineGeometry } from './coastline.js';

const COASTLINE_FILE = new URL(
  '../../../data/coastline.geojson',
  import.meta.url,
);
const geojson: unknown = JSON.parse(readFileSync(COASTLINE_FILE, 'utf8'));
const coastline = CoastlineGeometry.fromGeoJson(geojson);

type Ring = [number, number][];

/** Outer rings of the shipped file, in legacy iteration order. */
function legacyRings(): Ring[] {
  const collection = geojson as {
    features: { geometry: { type: string; coordinates: unknown } }[];
  };
  const rings: Ring[] = [];
  for (const feature of collection.features) {
    const { type, coordinates } = feature.geometry;
    if (type === 'Polygon') rings.push((coordinates as Ring[])[0] ?? []);
    if (type === 'MultiPolygon') {
      for (const polygon of coordinates as Ring[][])
        rings.push(polygon[0] ?? []);
    }
  }
  return rings;
}
const rings = legacyRings();

/**
 * Legacy `findNearestCoastDistance` (be-legacy/src/utils/calculate-ews.ts)
 * verbatim on turf 7.2.0, minus the per-call file read.
 */
function legacyCoastDistance(lat: number, lon: number): number {
  const pt = point([lon, lat]);
  let minDistance: number | null = null;
  for (const coords of rings) {
    const line = { type: 'LineString', coordinates: coords } as const;
    const nearest = nearestPointOnLine(line, pt);
    const d = distance(pt, nearest, { units: 'meters' });
    if (minDistance === null || d < minDistance) minDistance = d;
  }
  return minDistance ?? Infinity;
}

/** mulberry32: reproducible pseudo-random numbers in [0, 1). */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('CoastlineGeometry (geo.coast_distance)', () => {
  it('loads the legacy geometry: 18 outer rings, 598 segments', () => {
    expect(coastline.summary).toMatchObject({
      rings: 18,
      segments: 598,
      skippedSegments: 0,
      ignoredFeatures: 0,
    });
    const [minLon, minLat, maxLon, maxLat] = coastline.summary.bbox ?? [];
    expect(minLon).toBeCloseTo(110.895, 2);
    expect(maxLon).toBeCloseTo(115.902, 2);
    expect(minLat).toBeCloseTo(-8.78, 2);
    expect(maxLat).toBeCloseTo(-5.429, 2);
  });

  it.each(LEGACY_GOLDENS.coast.map((golden) => [golden.name, golden]))(
    'golden %s equals legacy findNearestCoastDistance exactly',
    (_name, golden) => {
      expect(coastline.distanceM(golden.lat, golden.lon)).toBe(golden.meters);
    },
  );

  it(
    'equals the legacy turf scan bit for bit on 1 500 random positions',
    { timeout: 60_000 },
    () => {
      const random = prng(7);
      const mismatches: string[] = [];
      for (let i = 0; i < 1500; i += 1) {
        // Mostly around East Java, some anywhere in Indonesia and the world.
        const [lat, lon] =
          i % 10 < 7
            ? [-9.5 + random() * 5, 110 + random() * 7]
            : i % 10 < 9
              ? [-11 + random() * 17, 95 + random() * 46]
              : [-80 + random() * 160, -180 + random() * 360];
        const expected = legacyCoastDistance(lat, lon);
        const actual = coastline.distanceM(lat, lon);
        if (actual !== expected)
          mismatches.push(`${lat},${lon}: ${actual} ≠ ${expected}`);
      }
      expect(mismatches).toEqual([]);
    },
  );

  it('is exact on vertices and on points of a segment', () => {
    for (const ring of rings.slice(0, 4)) {
      for (const [lon, lat] of ring.slice(0, 5)) {
        expect(coastline.distanceM(lat, lon)).toBe(0);
        expect(coastline.distanceM(lat + 1e-7, lon - 1e-7)).toBe(
          legacyCoastDistance(lat + 1e-7, lon - 1e-7),
        );
      }
    }
  });

  it('returns Infinity without polygons (legacy) and ignores other geometries', () => {
    const empty = CoastlineGeometry.fromGeoJson({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [1, 2] },
        },
      ],
    });
    expect(empty.summary).toMatchObject({
      rings: 0,
      segments: 0,
      ignoredFeatures: 1,
    });
    expect(empty.distanceM(-7, 112)).toBe(Number.POSITIVE_INFINITY);
  });

  it('skips zero-length segments (turf cannot project onto them)', () => {
    const polygon = CoastlineGeometry.fromGeoJson({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
        },
      ],
    });
    expect(polygon.summary).toMatchObject({ segments: 3, skippedSegments: 1 });
    expect(polygon.distanceM(0, 0.5)).toBeLessThan(1e-6);
    expect(polygon.distanceM(0.5, 1)).toBeLessThan(1e-6);
  });

  it.each([
    [null],
    [{ type: 'Feature' }],
    [
      {
        type: 'FeatureCollection',
        features: [
          { geometry: { type: 'Polygon', coordinates: [[[0, 'x']]] } },
        ],
      },
    ],
    [
      {
        type: 'FeatureCollection',
        features: [
          {
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [170, 0],
                  [-170, 0],
                  [170, 1],
                  [170, 0],
                ],
              ],
            },
          },
        ],
      },
    ],
  ])('refuses unusable documents (%j)', (document) => {
    expect(() => CoastlineGeometry.fromGeoJson(document)).toThrow(
      CoastlineFormatError,
    );
  });

  it('answers in well under a millisecond per position', () => {
    const random = prng(11);
    const started = performance.now();
    for (let i = 0; i < 2000; i += 1) {
      coastline.distanceM(-9.5 + random() * 5, 110 + random() * 7);
    }
    const perCallMs = (performance.now() - started) / 2000;
    expect(perCallMs).toBeLessThan(1);
  });
});
