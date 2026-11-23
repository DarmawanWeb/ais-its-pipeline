import {
  AIS_SOURCES,
  type AisSource,
} from '@darmawanweb/ais-its-contracts/domain';
import { Injectable } from '@nestjs/common';

import { StatsRepository, type TrafficBucketRow } from './stats.repository.js';

/** A vessel is active when its latest position is at most this old. */
export const ACTIVE_WINDOW_MS = 10 * 60_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Bucket sizes of `GET /ais/stats/series`. */
export const STATS_BUCKETS = ['1m', '5m', '1h'] as const;
export type StatsBucket = (typeof STATS_BUCKETS)[number];

/** Length of a bucket [ms]. */
export const STATS_BUCKET_MS: Readonly<Record<StatsBucket, number>> = {
  '1m': MINUTE_MS,
  '5m': 5 * MINUTE_MS,
  '1h': HOUR_MS,
};

/** PostgreSQL interval of a bucket (`time_bucket`, aligned to UTC). */
const BUCKET_INTERVAL: Readonly<Record<StatsBucket, string>> = {
  '1m': '1 minute',
  '5m': '5 minutes',
  '1h': '1 hour',
};

/** Default range of a series (ending now): 1 h of minutes, 24 h of 5 minutes, 7 days of hours. */
export const STATS_SERIES_DEFAULT_RANGE_MS: Readonly<
  Record<StatsBucket, number>
> = { '1m': HOUR_MS, '5m': DAY_MS, '1h': 7 * DAY_MS };

/** Longest range of a series: at most 2 160 points (24 h of minutes, 7 days of 5 minutes, 90 days of hours). */
export const STATS_SERIES_MAX_RANGE_MS: Readonly<Record<StatsBucket, number>> =
  { '1m': DAY_MS, '5m': 7 * DAY_MS, '1h': 90 * DAY_MS };

/** Counts of one feed (or of all of them). */
export interface FeedStats {
  readonly activeVessels: number;
  readonly messagesLastMinute: number;
}

/** `GET /ais/stats`. */
export interface AisStats extends FeedStats {
  readonly at: Date;
  readonly activeWindowMinutes: number;
  readonly bySource: Readonly<Record<AisSource, FeedStats>>;
}

/** Counters of one feed (or of all of them) in a series bucket. */
export interface FeedTraffic {
  /** Positions recorded in the bucket's sampled minutes. */
  readonly messages: number;
  /** Active vessels at the end of the bucket's last sampled minute. */
  readonly activeVessels: number;
}

/** A bucket of `GET /ais/stats/series`. */
export interface TrafficPoint extends FeedTraffic {
  /** Start of the bucket. */
  readonly at: Date;
  /** Sampled minutes in the bucket (fewer than the bucket's minutes: a gap). */
  readonly samples: number;
  readonly bySource: Readonly<Record<AisSource, FeedTraffic>>;
}

/** `GET /ais/stats/series`. */
export interface TrafficSeries {
  /** `from` of the request floored to the bucket. */
  readonly from: Date;
  readonly to: Date;
  readonly bucket: StatsBucket;
  readonly bucketMinutes: number;
  readonly activeWindowMinutes: number;
  /** Buckets with at least one sampled minute, in time order. */
  readonly points: readonly TrafficPoint[];
}

const NO_TRAFFIC: FeedTraffic = { messages: 0, activeVessels: 0 };

/** The bucket of `time`: `time` floored to a multiple of the bucket since the epoch (UTC). */
export function bucketStart(time: Date, bucket: StatsBucket): Date {
  const size = STATS_BUCKET_MS[bucket];
  return new Date(Math.floor(time.getTime() / size) * size);
}

/** Groups the per-feed rows of each bucket (time order) into points; feeds without a row count zero. */
export function trafficPoints(
  rows: readonly TrafficBucketRow[],
): TrafficPoint[] {
  const buckets = new Map<number, TrafficBucketRow[]>();
  for (const row of rows) {
    const key = row.at.getTime();
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [row]);
    else bucket.push(row);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([at, feeds]) => {
      const feed = (source: AisSource): FeedTraffic => {
        const row = feeds.find((candidate) => candidate.source === source);
        return row === undefined
          ? NO_TRAFFIC
          : { messages: row.messages, activeVessels: row.activeVessels };
      };
      // Every feed, also those without traffic (a new AisSource fails to compile here).
      const bySource: Record<AisSource, FeedTraffic> = {
        primary: feed('primary'),
        batam: feed('batam'),
        pusher: feed('pusher'),
      };
      const total = (pick: (traffic: FeedTraffic) => number): number =>
        AIS_SOURCES.reduce((sum, source) => sum + pick(bySource[source]), 0);
      return {
        at: new Date(at),
        samples: Math.max(...feeds.map((row) => row.samples)),
        messages: total((traffic) => traffic.messages),
        activeVessels: total((traffic) => traffic.activeVessels),
        bySource,
      };
    });
}

/** Live counters from the database (consistent across processor replicas) and their history. */
@Injectable()
export class StatsService {
  constructor(private readonly repository: StatsRepository) {}

  /**
   * `activeVessels`: vessels with a position in the last 10 minutes;
   * `messagesLastMinute`: positions recorded with a position time in the last minute.
   */
  async stats(now: Date = new Date()): Promise<AisStats> {
    const [active, recorded] = await Promise.all([
      this.repository.activeVessels(new Date(now.getTime() - ACTIVE_WINDOW_MS)),
      this.repository.recordedPositions(new Date(now.getTime() - 60_000)),
    ]);
    const feed = (source: AisSource): FeedStats => ({
      activeVessels: active.get(source) ?? 0,
      messagesLastMinute: recorded.get(source) ?? 0,
    });
    // Every feed, also those without traffic (a new AisSource fails to compile here).
    const bySource: Record<AisSource, FeedStats> = {
      primary: feed('primary'),
      batam: feed('batam'),
      pusher: feed('pusher'),
    };
    const total = (pick: (stats: FeedStats) => number): number =>
      AIS_SOURCES.reduce((sum, source) => sum + pick(bySource[source]), 0);
    return {
      at: now,
      activeWindowMinutes: ACTIVE_WINDOW_MS / 60_000,
      activeVessels: total((stats) => stats.activeVessels),
      messagesLastMinute: total((stats) => stats.messagesLastMinute),
      bySource,
    };
  }

  /**
   * The sampled history of {@link stats} over `[from, to)` in buckets
   * (`from` floored to the bucket): per bucket the positions recorded in
   * its sampled minutes and the active vessels at the end of its last
   * sampled minute, in total and per feed. Buckets without any sample (no
   * processor ran) are left out.
   */
  async series(request: {
    readonly from: Date;
    readonly to: Date;
    readonly bucket: StatsBucket;
  }): Promise<TrafficSeries> {
    const from = bucketStart(request.from, request.bucket);
    const rows = await this.repository.trafficBuckets(
      BUCKET_INTERVAL[request.bucket],
      from,
      request.to,
    );
    return {
      from,
      to: request.to,
      bucket: request.bucket,
      bucketMinutes: STATS_BUCKET_MS[request.bucket] / MINUTE_MS,
      activeWindowMinutes: ACTIVE_WINDOW_MS / MINUTE_MS,
      points: trafficPoints(rows),
    };
  }
}
