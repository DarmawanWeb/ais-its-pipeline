import type { BBox } from '@darmawanweb/ais-its-contracts/domain';
import { Injectable } from '@nestjs/common';

import { simplifyTrack } from '../../../shared/domain/simplify.js';
import { AisPositionNotFoundError } from './errors.js';
import type {
  Track,
  TrackPoint,
  TrackResolution,
  VesselLatest,
} from './positions.model.js';
import { PositionsRepository } from './positions.repository.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Default `since` of `GET /ais/latest`: the last 24 h (legacy `GET /ais` window). */
export const LATEST_DEFAULT_WINDOW_MS = DAY_MS;
/** Default and largest `limit` of `GET /ais/latest`. */
export const LATEST_DEFAULT_LIMIT = 10_000;
export const LATEST_MAX_LIMIT = 50_000;
/** Most MMSIs of one `GET /ais/latest?mmsi=` batch lookup (a page of a vessel list). */
export const LATEST_MAX_MMSIS = 100;
/** Default track range (last 24 h) and the longest range per resolution (spec: raw ≤ 7 d). */
export const TRACK_DEFAULT_RANGE_MS = DAY_MS;
export const TRACK_MAX_RANGE_MS: Readonly<Record<TrackResolution, number>> = {
  raw: 7 * DAY_MS,
  '1m': 90 * DAY_MS,
};
/**
 * Most points of one track before simplification; beyond, the newest are
 * returned (`truncated`, `remainingTo`).
 */
export const TRACK_MAX_POINTS = 100_000;

/** Range, resolution and simplification of a track request. */
export interface TrackOptions {
  readonly from: Date;
  readonly to: Date;
  readonly resolution: TrackResolution;
  /** Douglas–Peucker tolerance [m]; 0 or `undefined` = none. */
  readonly simplifyM?: number | undefined;
}

/** A resolved track request. */
export interface TrackRequest extends TrackOptions {
  readonly mmsi: number;
}

/** Filters of a `GET /ais/latest` request. */
export interface LatestQuery {
  readonly bbox: BBox | undefined;
  /** Default 24 h ago, none with {@link mmsis}. */
  readonly since: Date | undefined;
  /** Only these vessels (batch lookup, at most {@link LATEST_MAX_MMSIS}). */
  readonly mmsis?: readonly number[] | undefined;
  readonly limit: number;
}

/** Latest positions of a `GET /ais/latest` request. */
export interface LatestPositions {
  /** Newest first, at most the requested `limit`. */
  readonly vessels: readonly VesselLatest[];
  /** More vessels matched than `limit` (the least recently seen were left out). */
  readonly truncated: boolean;
}

/** Use cases of the AIS query API (positions are shared across tenants, spec §8.5). */
@Injectable()
export class PositionsService {
  constructor(private readonly repository: PositionsRepository) {}

  /**
   * Latest position of every vessel seen since `since` (default 24 h),
   * inside `bbox`, newest first; one row more than `limit` is read to tell
   * whether the result is complete. With `mmsis` only those vessels are
   * returned (those never recorded are omitted), and `since` has no
   * default: a vessel list shows when each vessel was last seen, however
   * long ago.
   */
  async latest(
    query: LatestQuery,
    now: Date = new Date(),
  ): Promise<LatestPositions> {
    const rows = await this.repository.latest({
      bbox: query.bbox,
      since:
        query.since ??
        (query.mmsis === undefined
          ? new Date(now.getTime() - LATEST_DEFAULT_WINDOW_MS)
          : undefined),
      mmsis: query.mmsis,
      limit: query.limit + 1,
    });
    return {
      vessels: rows.length > query.limit ? rows.slice(0, query.limit) : rows,
      truncated: rows.length > query.limit,
    };
  }

  /** @throws {AisPositionNotFoundError} `404` when the vessel was never recorded */
  async latestOf(mmsi: number): Promise<VesselLatest> {
    const latest = await this.repository.latestOf(mmsi);
    if (latest === null) throw new AisPositionNotFoundError(mmsi);
    return latest;
  }

  /**
   * A vessel's track (`raw` positions or `1m` buckets), optionally
   * simplified. Beyond {@link TRACK_MAX_POINTS} the newest points are kept
   * (`truncated`); `remainingTo` is then the `to` of the request for the
   * older rest of the range.
   */
  async track(request: TrackRequest): Promise<Track> {
    const range = {
      mmsi: request.mmsi,
      // 1m buckets are labelled with their start: include the bucket holding `from`.
      from:
        request.resolution === '1m'
          ? floorToMinute(request.from)
          : request.from,
      to: request.to,
      limit: TRACK_MAX_POINTS + 1,
    };
    const points =
      request.resolution === 'raw'
        ? await this.repository.rawTrack(range)
        : await this.repository.minuteTrack(range);
    // The newest points, in time order: the oldest one is the surplus.
    const truncated = points.length > TRACK_MAX_POINTS;
    const kept: readonly TrackPoint[] = truncated
      ? points.slice(points.length - TRACK_MAX_POINTS)
      : points;
    const first = kept[0];
    const remainingTo =
      truncated && first !== undefined
        ? new Date(first.time.getTime() - 1)
        : null;
    const simplifyM =
      request.simplifyM !== undefined && request.simplifyM > 0
        ? request.simplifyM
        : null;
    return {
      mmsi: request.mmsi,
      from: request.from,
      to: request.to,
      resolution: request.resolution,
      simplifyM,
      truncated,
      remainingTo,
      points: simplifyM === null ? kept : simplifyTrack(kept, simplifyM),
    };
  }

  /**
   * Tracks of two vessels over the same range, resolution and
   * simplification (legacy `GET /ais/routes/:mmsi1/:mmsi2`, raw by default),
   * each limited and truncated like {@link track}.
   */
  async pairTrack(
    mmsi1: number,
    mmsi2: number,
    options: TrackOptions,
  ): Promise<readonly Track[]> {
    return Promise.all(
      [mmsi1, mmsi2].map((mmsi) => this.track({ ...options, mmsi })),
    );
  }
}

function floorToMinute(time: Date): Date {
  return new Date(Math.floor(time.getTime() / 60_000) * 60_000);
}
