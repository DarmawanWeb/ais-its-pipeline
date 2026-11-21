import { describe, expect, it } from 'vitest';

import { simplifyTrack } from './simplify.js';

/** ~111 m per 0.001° of latitude near the equator. */
const track = [
  { lat: 0, lon: 0, id: 'a' },
  { lat: 0.00001, lon: 0.001, id: 'b' }, // 1.1 m off the chord
  { lat: 0, lon: 0.002, id: 'c' },
  { lat: 0.001, lon: 0.003, id: 'd' }, // corner, ~111 m off
  { lat: 0.002, lon: 0.003, id: 'e' },
];

describe('simplifyTrack', () => {
  it('drops points within the tolerance and keeps corners and endpoints', () => {
    expect(simplifyTrack(track, 10).map((p) => p.id)).toEqual([
      'a',
      'c',
      'd',
      'e',
    ]);
    expect(simplifyTrack(track, 0.5).map((p) => p.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    expect(simplifyTrack(track, 1000).map((p) => p.id)).toEqual(['a', 'e']);
  });

  it('keeps everything for a non-positive tolerance or short tracks', () => {
    expect(simplifyTrack(track, 0)).toEqual(track);
    expect(simplifyTrack(track.slice(0, 2), 100)).toEqual(track.slice(0, 2));
  });

  it('returns the original objects in order', () => {
    const result = simplifyTrack(track, 10);
    expect(result[0]).toBe(track[0]);
  });

  it('unwraps longitudes across the antimeridian', () => {
    const crossing = [
      { lat: 0, lon: 179.999 },
      { lat: 0.00001, lon: -180 },
      { lat: 0, lon: -179.999 },
    ];
    expect(simplifyTrack(crossing, 10)).toHaveLength(2);
  });

  it('handles long tracks iteratively', () => {
    const long = Array.from({ length: 100_000 }, (_, i) => ({
      lat: Math.sin(i / 50) * 0.01,
      lon: i * 0.0001,
    }));
    const simplified = simplifyTrack(long, 5);
    expect(simplified.length).toBeGreaterThan(2);
    expect(simplified.length).toBeLessThan(long.length);
  });
});
