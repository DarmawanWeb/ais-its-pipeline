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
/** Default track range (last 24 h) and the longest range per resolution (spec: raw ≤ 7 d). */
export const TRACK_DEFAULT_RANGE_MS = DAY_MS;
export const TRACK_MAX_RANGE_MS: Readonly<Record<TrackResolution, number>> = {
  raw: 7 * DAY_MS,
  '1m': 90 * DAY_MS,
};
/** Most points of one track before simplification (`truncated` beyond). */
export const TRACK_MAX_POINTS = 100_000;

/** A resolved track request. */
export interface TrackRequest {
  readonly mmsi: number;
  readonly from: Date;
  readonly to: Date;
  readonly resolution: TrackResolution;
  /** Douglas–Peucker tolerance [m]; 0 or `undefined` = none. */
  readonly simplifyM?: number | undefined;
}

/** Use cases of the AIS query API (positions are shared across tenants, spec §8.5). */
@Injectable()
export class PositionsService {
  constructor(private readonly repository: PositionsRepository) {}

  /** Latest position of every vessel seen since `since` (default 24 h), inside `bbox`. */
  latest(
    query: {
      readonly bbox: BBox | undefined;
      readonly since: Date | undefined;
      readonly limit: number;
    },
    now: Date = new Date(),
  ): Promise<VesselLatest[]> {
    return this.repository.latest({
      bbox: query.bbox,
      since: query.since ?? new Date(now.getTime() - LATEST_DEFAULT_WINDOW_MS),
      limit: query.limit,
    });
  }

  /** @throws {AisPositionNotFoundError} `404` when the vessel was never recorded */
  async latestOf(mmsi: number): Promise<VesselLatest> {
    const latest = await this.repository.latestOf(mmsi);
    if (latest === null) throw new AisPositionNotFoundError(mmsi);
    return latest;
  }

  /** A vessel's track (`raw` positions or `1m` buckets), optionally simplified. */
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
    const truncated = points.length > TRACK_MAX_POINTS;
    const kept: readonly TrackPoint[] = truncated
      ? points.slice(0, TRACK_MAX_POINTS)
      : points;
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
      points: simplifyM === null ? kept : simplifyTrack(kept, simplifyM),
    };
  }

  /** Raw tracks of two vessels over the same range (legacy `GET /ais/routes/:mmsi1/:mmsi2`). */
  async pairTrack(
    mmsi1: number,
    mmsi2: number,
    from: Date,
    to: Date,
  ): Promise<readonly Track[]> {
    return Promise.all(
      [mmsi1, mmsi2].map((mmsi) =>
        this.track({ mmsi, from, to, resolution: 'raw' }),
      ),
    );
  }
}

function floorToMinute(time: Date): Date {
  return new Date(Math.floor(time.getTime() / 60_000) * 60_000);
}
