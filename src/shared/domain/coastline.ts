import Flatbush from 'flatbush';

/** Earth radius of turf 7.2.0 (`@turf/helpers` `earthRadius`) [m]. */
export const TURF_EARTH_RADIUS_M = 63710088e-1;

/** turf `factors.kilometers`: the unit nearestPointOnLine compares distances in. */
const KILOMETERS_PER_RADIAN = TURF_EARTH_RADIUS_M / 1e3;

/** Slack of the pruning bounds (floating-point noise of the trigonometry). */
const PRUNE_RELATIVE_SLACK = 1e-9;
const PRUNE_ABSOLUTE_SLACK_RAD = 1e-15;
/** Margin added to every segment's box [deg] (round trips through 3-D vectors). */
const BOX_MARGIN_DEG = 1e-9;
/** Planar nearest boxes evaluated to seed the search radius. */
const SEED_CANDIDATES = 4;

type Vec3 = readonly [number, number, number];

// --- turf 7.2.0 arithmetic, operation for operation (parity) -----------------

/** `@turf/helpers` `degreesToRadians`. */
function degreesToRadians(degrees: number): number {
  const normalisedDegrees = degrees % 360;
  return (normalisedDegrees * Math.PI) / 180;
}

/** `@turf/helpers` `radiansToDegrees`. */
function radiansToDegrees(radians: number): number {
  const normalisedRadians = radians % (2 * Math.PI);
  return (normalisedRadians * 180) / Math.PI;
}

/** `@turf/nearest-point-on-line` `lngLatToVector`. */
function lngLatToVector(lon: number, lat: number): Vec3 {
  const latRad = degreesToRadians(lat);
  const lngRad = degreesToRadians(lon);
  return [
    Math.cos(latRad) * Math.cos(lngRad),
    Math.cos(latRad) * Math.sin(lngRad),
    Math.sin(latRad),
  ];
}

/** `@turf/nearest-point-on-line` `vectorToLngLat`: `[lon, lat]`. */
function vectorToLngLat(v: Vec3): [number, number] {
  const lat = radiansToDegrees(Math.asin(v[2]));
  const lng = radiansToDegrees(Math.atan2(v[1], v[0]));
  return [lng, lat];
}

function dot(v1: Vec3, v2: Vec3): number {
  return v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
}

function cross(v1: Vec3, v2: Vec3): Vec3 {
  return [
    v1[1] * v2[2] - v1[2] * v2[1],
    v1[2] * v2[0] - v1[0] * v2[2],
    v1[0] * v2[1] - v1[1] * v2[0],
  ];
}

function magnitude(v: Vec3): number {
  return Math.sqrt(Math.pow(v[0], 2) + Math.pow(v[1], 2) + Math.pow(v[2], 2));
}

/** `angle(v1, v2)` with the magnitudes passed in (precomputed for vertices). */
function angleOf(v1: Vec3, m1: number, v2: Vec3, m2: number): number {
  const theta = dot(v1, v2) / (m1 * m2);
  return Math.acos(Math.min(Math.max(theta, -1), 1));
}

/**
 * Central angle of `@turf/distance` (haversine) between `[lon, lat]`
 * positions [rad]; multiply by the turf unit factor for a length.
 */
function turfCentralAngle(
  fromLon: number,
  fromLat: number,
  toLon: number,
  toLat: number,
): number {
  const dLat = degreesToRadians(toLat - fromLat);
  const dLon = degreesToRadians(toLon - fromLon);
  const lat1 = degreesToRadians(fromLat);
  const lat2 = degreesToRadians(toLat);
  const a =
    Math.pow(Math.sin(dLat / 2), 2) +
    Math.pow(Math.sin(dLon / 2), 2) * Math.cos(lat1) * Math.cos(lat2);
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- geometry ------------------------------------------------------------------

/** Summary of loaded coastline geometry (logs, readiness, tests). */
export interface CoastlineSummary {
  /** Outer rings used as lines (one per polygon part). */
  readonly rings: number;
  readonly segments: number;
  /** Zero-length segments skipped (turf would fail on them). */
  readonly skippedSegments: number;
  /** Features whose geometry is not a (Multi)Polygon, ignored as in legacy. */
  readonly ignoredFeatures: number;
  /** `[minLon, minLat, maxLon, maxLat]`, `null` without segments. */
  readonly bbox: readonly [number, number, number, number] | null;
}

/** Thrown for a coastline file that is not a usable GeoJSON FeatureCollection. */
export class CoastlineFormatError extends Error {
  override readonly name = 'CoastlineFormatError';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A `[lon, lat]` pair of a ring. */
function positionOf(value: unknown, where: string): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    typeof value[0] !== 'number' ||
    typeof value[1] !== 'number' ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1])
  ) {
    throw new CoastlineFormatError(`${where}: invalid position`);
  }
  return [value[0], value[1]];
}

/** The outer rings (`coordinates[0]` of every polygon part) in legacy order. */
function outerRingsOf(json: unknown): {
  rings: [number, number][][];
  ignoredFeatures: number;
} {
  if (
    !isRecord(json) ||
    json.type !== 'FeatureCollection' ||
    !Array.isArray(json.features)
  ) {
    throw new CoastlineFormatError('Expected a GeoJSON FeatureCollection');
  }
  const rings: [number, number][][] = [];
  let ignoredFeatures = 0;
  const ringOf = (polygon: unknown, where: string): void => {
    if (!Array.isArray(polygon) || !Array.isArray(polygon[0])) {
      throw new CoastlineFormatError(`${where}: invalid polygon`);
    }
    const outer: unknown[] = polygon[0];
    rings.push(
      outer.map((position, i) => positionOf(position, `${where}[${i}]`)),
    );
  };
  json.features.forEach((feature: unknown, index) => {
    const geometry = isRecord(feature) ? feature.geometry : undefined;
    if (!isRecord(geometry)) {
      ignoredFeatures += 1;
      return;
    }
    if (geometry.type === 'Polygon') {
      ringOf(geometry.coordinates, `features[${index}]`);
    } else if (
      geometry.type === 'MultiPolygon' &&
      Array.isArray(geometry.coordinates)
    ) {
      const parts: unknown[] = geometry.coordinates;
      parts.forEach((part, partIndex) => {
        ringOf(part, `features[${index}].coordinates[${partIndex}]`);
      });
    } else {
      ignoredFeatures += 1;
    }
  });
  return { rings, ignoredFeatures };
}

/**
 * Latitude range [deg] of the minor great-circle arc A→B: the endpoints, plus
 * the great circle's northern/southern vertex when it lies on the arc (an
 * arc bulges towards the pole beyond its endpoints' latitudes).
 */
function arcLatitudeRange(
  a: Vec3,
  b: Vec3,
  normal: Vec3,
  latA: number,
  latB: number,
): [number, number] {
  let min = Math.min(latA, latB);
  let max = Math.max(latA, latB);
  const nn = dot(normal, normal);
  // The point of the great circle with the largest z: ẑ minus its normal component.
  const vx = (-normal[2] * normal[0]) / nn;
  const vy = (-normal[2] * normal[1]) / nn;
  const vz = 1 - (normal[2] * normal[2]) / nn;
  const length = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (length > 0) {
    const north: Vec3 = [vx / length, vy / length, vz / length];
    const south: Vec3 = [-north[0], -north[1], -north[2]];
    const onArc = (p: Vec3): boolean =>
      dot(cross(a, p), normal) >= 0 && dot(cross(p, b), normal) >= 0;
    const toDegrees = (z: number): number =>
      (Math.asin(Math.min(Math.max(z, -1), 1)) * 180) / Math.PI;
    if (onArc(north)) max = Math.max(max, toDegrees(north[2]));
    if (onArc(south)) min = Math.min(min, toDegrees(south[2]));
  }
  return [min, max];
}

/** Smallest longitude difference [deg] from `lon` to `[minLon, maxLon]` on the circle. */
function longitudeGap(lon: number, minLon: number, maxLon: number): number {
  if (lon >= minLon && lon <= maxLon) return 0;
  const circular = (x: number, y: number): number => {
    const d = Math.abs(x - y) % 360;
    return d > 180 ? 360 - d : d;
  };
  return Math.min(circular(lon, minLon), circular(lon, maxLon));
}

/**
 * The legacy "coast" geometry, loaded once and indexed: every outer ring of
 * every (Multi)Polygon part as a line, its segments in a flatbush R-tree
 * over the lon/lat boxes of their great-circle arcs.
 */
export class CoastlineGeometry {
  private constructor(
    /** Per vertex: original lon/lat, unit vector, its magnitude and the vector's lon/lat round trip. */
    private readonly lon: Float64Array,
    private readonly lat: Float64Array,
    private readonly vec: Float64Array,
    private readonly vecMagnitude: Float64Array,
    private readonly roundTrip: Float64Array,
    /** Per segment: start vertex (end = start + 1), ring, cross(A, B), angle(A, B), box, min cos(lat). */
    private readonly segmentStart: Uint32Array,
    private readonly segmentRing: Uint32Array,
    private readonly segmentNormal: Float64Array,
    private readonly segmentAngle: Float64Array,
    private readonly segmentBox: Float64Array,
    private readonly segmentMinCosLat: Float64Array,
    private readonly ringCount: number,
    private readonly index: Flatbush | null,
    readonly summary: CoastlineSummary,
  ) {}

  /**
   * Builds the index from a GeoJSON FeatureCollection (legacy
   * `data/indonesia.json`, shipped as `data/coastline.geojson`).
   *
   * @method data.indonesia_coastline (the "coastline" is the simplified Jawa Timur province polygon)
   * @see ../../../../../docs/METHODOLOGY.md#data.indonesia_coastline
   * @throws {CoastlineFormatError} when the document is not a FeatureCollection of valid rings.
   */
  static fromGeoJson(json: unknown): CoastlineGeometry {
    const { rings, ignoredFeatures } = outerRingsOf(json);
    const vertices = rings.reduce((sum, ring) => sum + ring.length, 0);
    const lon = new Float64Array(vertices);
    const lat = new Float64Array(vertices);
    const vec = new Float64Array(vertices * 3);
    const vecMagnitude = new Float64Array(vertices);
    const roundTrip = new Float64Array(vertices * 2);
    const starts: number[] = [];
    const ringOfSegment: number[] = [];
    let skippedSegments = 0;
    let v = 0;
    rings.forEach((ring, ringIndex) => {
      ring.forEach(([x, y], i) => {
        const vector = lngLatToVector(x, y);
        lon[v] = x;
        lat[v] = y;
        vec.set(vector, v * 3);
        vecMagnitude[v] = magnitude(vector);
        roundTrip.set(vectorToLngLat(vector), v * 2);
        if (i < ring.length - 1) {
          const next = ring[i + 1];
          if (next?.[0] === x && next[1] === y) {
            skippedSegments += 1;
          } else {
            starts.push(v);
            ringOfSegment.push(ringIndex);
          }
        }
        v += 1;
      });
    });

    const segments = starts.length;
    const segmentStart = Uint32Array.from(starts);
    const segmentRing = Uint32Array.from(ringOfSegment);
    const segmentNormal = new Float64Array(segments * 3);
    const segmentAngle = new Float64Array(segments);
    const segmentBox = new Float64Array(segments * 4);
    const segmentMinCosLat = new Float64Array(segments);
    const index = segments > 0 ? new Flatbush(segments) : null;
    let bbox: [number, number, number, number] | null = null;
    const vectorAt = (i: number): Vec3 => [
      vec[i * 3] ?? 0,
      vec[i * 3 + 1] ?? 0,
      vec[i * 3 + 2] ?? 0,
    ];
    for (let s = 0; s < segments; s += 1) {
      const i = segmentStart[s] ?? 0;
      const a = vectorAt(i);
      const b = vectorAt(i + 1);
      const normal = cross(a, b);
      segmentNormal.set(normal, s * 3);
      segmentAngle[s] = angleOf(
        a,
        vecMagnitude[i] ?? 1,
        b,
        vecMagnitude[i + 1] ?? 1,
      );
      const lonA = lon[i] ?? 0;
      const lonB = lon[i + 1] ?? 0;
      if (Math.abs(lonA - lonB) > 180) {
        throw new CoastlineFormatError(
          'Segments crossing the antimeridian are not supported',
        );
      }
      const [minLat, maxLat] = arcLatitudeRange(
        a,
        b,
        normal,
        lat[i] ?? 0,
        lat[i + 1] ?? 0,
      );
      const box: [number, number, number, number] = [
        Math.min(lonA, lonB) - BOX_MARGIN_DEG,
        minLat - BOX_MARGIN_DEG,
        Math.max(lonA, lonB) + BOX_MARGIN_DEG,
        maxLat + BOX_MARGIN_DEG,
      ];
      segmentBox.set(box, s * 4);
      segmentMinCosLat[s] = Math.min(
        Math.cos((box[1] * Math.PI) / 180),
        Math.cos((box[3] * Math.PI) / 180),
      );
      index?.add(box[0], box[1], box[2], box[3]);
      bbox =
        bbox === null
          ? [...box]
          : [
              Math.min(bbox[0], box[0]),
              Math.min(bbox[1], box[1]),
              Math.max(bbox[2], box[2]),
              Math.max(bbox[3], box[3]),
            ];
    }
    index?.finish();
    return new CoastlineGeometry(
      lon,
      lat,
      vec,
      vecMagnitude,
      roundTrip,
      segmentStart,
      segmentRing,
      segmentNormal,
      segmentAngle,
      segmentBox,
      segmentMinCosLat,
      rings.length,
      index,
      { rings: rings.length, segments, skippedSegments, ignoredFeatures, bbox },
    );
  }

  /**
   * Distance from a position to the nearest point of the coast rings [m].
   *
   * Same value, bit for bit, as legacy `findNearestCoastDistance`: per ring,
   * turf 7.2.0 `nearestPointOnLine` (projection onto each segment's great
   * circle, falling back to the endpoint nearer to the projection; selected
   * by the smallest haversine distance in kilometres, first segment on
   * ties), then the haversine distance in metres with R = 6 371 008.8 m and
   * the minimum over rings. The R-tree only prunes segments that provably
   * cannot be nearer (a lower bound of the haversine distance to each arc's
   * box), so the result is the same as scanning every ring. Holes are
   * ignored and a position on land gets the distance to the boundary (not
   * 0), as in legacy.
   *
   * @method geo.coast_distance
   * @param lat - latitude [deg]
   * @param lon - longitude [deg]
   * @returns distance [m]; `Infinity` when the geometry has no polygon (legacy)
   * @see ../../../../../docs/METHODOLOGY.md#geo.coast_distance
   * @see be-legacy/src/utils/calculate-ews.ts (findNearestCoastDistance)
   * @see turfjs-7-2, turf-helpers-earthradius, flatbush (reference catalog)
   */
  distanceM(lat: number, lon: number): number {
    if (this.index === null) return Infinity;
    const c = lngLatToVector(lon, lat);
    const ringKm = new Float64Array(this.ringCount).fill(Infinity);
    const ringSegment = new Int32Array(this.ringCount).fill(-1);
    const ringAngle = new Float64Array(this.ringCount).fill(NaN);
    const evaluated = new Set<number>();
    let best = Infinity;

    const evaluate = (s: number): void => {
      if (evaluated.has(s)) return;
      evaluated.add(s);
      const theta = this.candidateAngle(s, lon, lat, c);
      if (!(theta >= 0)) return; // NaN: degenerate geometry, skipped
      const ring = this.segmentRing[s] ?? 0;
      const km = theta * KILOMETERS_PER_RADIAN;
      const current = ringKm[ring] ?? Infinity;
      if (km < current || (km === current && s < (ringSegment[ring] ?? -1))) {
        ringKm[ring] = km;
        ringSegment[ring] = s;
        ringAngle[ring] = theta;
      }
      if (theta < best) best = theta;
    };

    for (const s of this.index.neighbors(lon, lat, SEED_CANDIDATES)) {
      evaluate(s);
    }
    const phi = (lat * Math.PI) / 180;
    const cosPhi = Math.cos(phi);
    const candidates = this.searchCap(lon, lat, best).filter(
      (s) => !evaluated.has(s),
    );
    const bounds = candidates.map((s) => this.lowerBound(s, lon, lat, cosPhi));
    const order = candidates
      .map((_, i) => i)
      .sort((x, y) => (bounds[x] ?? 0) - (bounds[y] ?? 0));
    for (const i of order) {
      const bound = bounds[i] ?? 0;
      if (
        bound >
        best * (1 + PRUNE_RELATIVE_SLACK) + PRUNE_ABSOLUTE_SLACK_RAD
      ) {
        break;
      }
      evaluate(candidates[i] ?? 0);
    }

    let meters = Infinity;
    let found = false;
    for (let ring = 0; ring < this.ringCount; ring += 1) {
      if ((ringSegment[ring] ?? -1) < 0) continue;
      const d = (ringAngle[ring] ?? NaN) * TURF_EARTH_RADIUS_M;
      if (!found || d < meters) meters = d;
      found = true;
    }
    return meters;
  }

  /** Central angle [rad] to segment `s`'s nearest point as turf picks it. */
  private candidateAngle(s: number, lon: number, lat: number, c: Vec3): number {
    const i = this.segmentStart[s] ?? 0;
    const j = i + 1;
    const startLon = this.lon[i] ?? NaN;
    const startLat = this.lat[i] ?? NaN;
    const stopLon = this.lon[j] ?? NaN;
    const stopLat = this.lat[j] ?? NaN;
    if (startLon === lon && startLat === lat) {
      return turfCentralAngle(lon, lat, startLon, startLat);
    }
    if (stopLon === lon && stopLat === lat) {
      return turfCentralAngle(lon, lat, stopLon, stopLat);
    }
    const [x, y] = this.nearestPointOnSegment(s, i, j, c);
    return turfCentralAngle(lon, lat, x, y);
  }

  /** `@turf/nearest-point-on-line` `nearestPointOnSegment` with precomputed vertex terms. */
  private nearestPointOnSegment(
    s: number,
    i: number,
    j: number,
    c: Vec3,
  ): readonly [number, number] {
    const a = this.vector(i);
    const b = this.vector(j);
    const aMagnitude = this.vecMagnitude[i] ?? NaN;
    const bMagnitude = this.vecMagnitude[j] ?? NaN;
    const [cx, cy, cz] = c;
    const d = this.segmentNormal[s * 3] ?? NaN;
    const e = this.segmentNormal[s * 3 + 1] ?? NaN;
    const f0 = this.segmentNormal[s * 3 + 2] ?? NaN;
    const pa = e * cz - f0 * cy;
    const pb = f0 * cx - d * cz;
    const pc = d * cy - e * cx;
    const f = pc * e - pb * f0;
    const g = pa * f0 - pc * d;
    const h = pb * d - pa * e;
    const t = 1 / Math.sqrt(Math.pow(f, 2) + Math.pow(g, 2) + Math.pow(h, 2));
    const i1: Vec3 = [f * t, g * t, h * t];
    const i2: Vec3 = [-1 * f * t, -1 * g * t, -1 * h * t];
    const i1Magnitude = magnitude(i1);
    const i2Magnitude = magnitude(i2);
    const angleAB = this.segmentAngle[s] ?? NaN;
    const angleAI1 = angleOf(a, aMagnitude, i1, i1Magnitude);
    const angleBI1 = angleOf(b, bMagnitude, i1, i1Magnitude);
    const angleAI2 = angleOf(a, aMagnitude, i2, i2Magnitude);
    const angleBI2 = angleOf(b, bMagnitude, i2, i2Magnitude);
    const useFirst =
      (angleAI1 < angleAI2 && angleAI1 < angleBI2) ||
      (angleBI1 < angleAI2 && angleBI1 < angleBI2);
    const nearest = useFirst ? i1 : i2;
    const angleAI = useFirst ? angleAI1 : angleAI2;
    const angleBI = useFirst ? angleBI1 : angleBI2;
    if (angleAI > angleAB || angleBI > angleAB) {
      const [nx, ny] = vectorToLngLat(nearest);
      const ax = this.roundTrip[i * 2] ?? NaN;
      const ay = this.roundTrip[i * 2 + 1] ?? NaN;
      const bx = this.roundTrip[j * 2] ?? NaN;
      const by = this.roundTrip[j * 2 + 1] ?? NaN;
      const toA = turfCentralAngle(nx, ny, ax, ay) * KILOMETERS_PER_RADIAN;
      const toB = turfCentralAngle(nx, ny, bx, by) * KILOMETERS_PER_RADIAN;
      return toA <= toB ? [ax, ay] : [bx, by];
    }
    return vectorToLngLat(nearest);
  }

  private vector(i: number): Vec3 {
    return [
      this.vec[i * 3] ?? NaN,
      this.vec[i * 3 + 1] ?? NaN,
      this.vec[i * 3 + 2] ?? NaN,
    ];
  }

  /**
   * Segments whose box intersects the lon/lat box of the spherical cap of
   * radius `radius` [rad] around the position (all of them for an infinite radius).
   */
  private searchCap(lon: number, lat: number, radius: number): number[] {
    const index = this.index;
    if (index === null) return [];
    const radiusDeg =
      (radius * (1 + PRUNE_RELATIVE_SLACK) * 180) / Math.PI + BOX_MARGIN_DEG;
    if (!Number.isFinite(radiusDeg) || radiusDeg >= 180) {
      return index.search(-Infinity, -Infinity, Infinity, Infinity);
    }
    const minLat = lat - radiusDeg;
    const maxLat = lat + radiusDeg;
    const capRadians = (radiusDeg * Math.PI) / 180;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const reachesPole = Math.abs(lat) + radiusDeg >= 90;
    const lonSpan = reachesPole
      ? 180
      : (Math.asin(Math.min(1, Math.sin(capRadians) / cosLat)) * 180) /
          Math.PI +
        BOX_MARGIN_DEG;
    if (lonSpan >= 180)
      return index.search(-Infinity, minLat, Infinity, maxLat);
    const west = lon - lonSpan;
    const east = lon + lonSpan;
    const found = new Set(index.search(west, minLat, east, maxLat));
    // Wrap around the antimeridian.
    if (west < -180) {
      for (const s of index.search(west + 360, minLat, 180, maxLat))
        found.add(s);
    }
    if (east > 180) {
      for (const s of index.search(-180, minLat, east - 360, maxLat))
        found.add(s);
    }
    return [...found];
  }

  /**
   * Lower bound of the central angle [rad] from the position to any point of
   * segment `s`'s box: hav θ = hav Δφ + cos φ₁ cos φ₂ hav Δλ with the
   * smallest Δφ, Δλ and cos φ₂ the box allows.
   */
  private lowerBound(
    s: number,
    lon: number,
    lat: number,
    cosPhi: number,
  ): number {
    const minLon = this.segmentBox[s * 4] ?? NaN;
    const minLat = this.segmentBox[s * 4 + 1] ?? NaN;
    const maxLon = this.segmentBox[s * 4 + 2] ?? NaN;
    const maxLat = this.segmentBox[s * 4 + 3] ?? NaN;
    const dPhi = (Math.max(0, minLat - lat, lat - maxLat) * Math.PI) / 180;
    const dLambda = (longitudeGap(lon, minLon, maxLon) * Math.PI) / 180;
    const hav =
      Math.sin(dPhi / 2) ** 2 +
      Math.max(0, cosPhi * (this.segmentMinCosLat[s] ?? 0)) *
        Math.sin(dLambda / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(hav)));
  }
}
