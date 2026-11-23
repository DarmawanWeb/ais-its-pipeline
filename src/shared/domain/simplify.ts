/** Metres per degree of latitude on a sphere of radius 6 371 008.8 m. */
const METERS_PER_DEGREE = (Math.PI * 6_371_008.8) / 180;

/** A point of a track. */
export interface TrackVertex {
  readonly lat: number;
  readonly lon: number;
}

/**
 * Ramer–Douglas–Peucker simplification of a track for display: keeps the
 * first and last point and every point farther than `toleranceM` from the
 * chord of the span it belongs to. Distances are planar in a local
 * equirectangular projection (x = Δλ·cos φ₀, y = Δφ, φ₀ = mean latitude;
 * longitudes unwrapped across the antimeridian), adequate for display
 * tolerances of metres to kilometres. Iterative (no recursion depth limit);
 * the kept points are returned in their original order, unchanged.
 *
 * @method geo.track_simplification
 * @param points - track in time order
 * @param toleranceM - perpendicular distance tolerance [m]; ≤ 0 keeps every point
 * @see https://doi.org/10.3138/FM57-6770-U75U-7727 (Douglas & Peucker 1973)
 * @see https://doi.org/10.1016/S0146-664X(72)80017-0 (Ramer 1972)
 */
export function simplifyTrack<T extends TrackVertex>(
  points: readonly T[],
  toleranceM: number,
): T[] {
  if (points.length <= 2 || !(toleranceM > 0)) return [...points];
  const meanLat =
    points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const xScale = Math.cos((meanLat * Math.PI) / 180) * METERS_PER_DEGREE;
  const x = new Float64Array(points.length);
  const y = new Float64Array(points.length);
  let previousLon = points[0]?.lon ?? 0;
  let unwrapped = previousLon;
  points.forEach((point, i) => {
    let delta = point.lon - previousLon;
    if (delta > 180) delta -= 360;
    else if (delta < -180) delta += 360;
    unwrapped += i === 0 ? 0 : delta;
    previousLon = point.lon;
    x[i] = unwrapped * xScale;
    y[i] = point.lat * METERS_PER_DEGREE;
  });

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  const toleranceSquared = toleranceM * toleranceM;
  for (let span = stack.pop(); span !== undefined; span = stack.pop()) {
    const [first, last] = span;
    let farthest = -1;
    let farthestSquared = toleranceSquared;
    for (let i = first + 1; i < last; i += 1) {
      const d = segmentDistanceSquared(x, y, i, first, last);
      if (d > farthestSquared) {
        farthestSquared = d;
        farthest = i;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/** Squared distance [m²] from point `p` to the segment `a`–`b` (projected). */
function segmentDistanceSquared(
  x: Float64Array,
  y: Float64Array,
  p: number,
  a: number,
  b: number,
): number {
  const ax = x[a] ?? 0;
  const ay = y[a] ?? 0;
  const dx = (x[b] ?? 0) - ax;
  const dy = (y[b] ?? 0) - ay;
  const px = (x[p] ?? 0) - ax;
  const py = (y[p] ?? 0) - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared));
  const ex = px - t * dx;
  const ey = py - t * dy;
  return ex * ex + ey * ey;
}
