import type { AisSource } from '@darmawanweb/ais-its-contracts/domain';
import {
  type Database,
  InjectDb,
  InjectPool,
  type Pool,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { count, gte } from 'drizzle-orm';

import * as schema from '../db/schema.js';

const { positions, vesselLatest } = schema;

/** Counts per feed. */
export type CountsBySource = ReadonlyMap<AisSource, number>;

/** One feed's sampled minutes of a series bucket (`traffic_minutes`, `0005`). */
export interface TrafficBucketRow {
  /** Start of the bucket. */
  readonly at: Date;
  readonly source: AisSource;
  /** Sampled minutes in the bucket. */
  readonly samples: number;
  /** Positions recorded in the sampled minutes. */
  readonly messages: number;
  /** Active vessels of the bucket's last sampled minute. */
  readonly activeVessels: number;
}

/**
 * Samples one minute per feed into `traffic_minutes`: the positions recorded
 * with a position time in the minute and the vessels whose latest position
 * is at most the active window older than the minute's end (the counters of
 * `GET /ais/stats` at that time). `$1` is the minute (`NULL`: the last
 * completed minute by the database clock), `$2` the active window [s], `$3`
 * the feeds. An already sampled minute is left as is (another replica).
 */
const SAMPLE_MINUTE = `
WITH m AS (
  SELECT coalesce($1::timestamptz, date_trunc('minute', now()) - interval '1 minute') AS minute
),
recorded AS (
  SELECT p.source, count(*)::int AS n FROM positions p, m
  WHERE p.time >= m.minute AND p.time < m.minute + interval '1 minute'
  GROUP BY p.source
),
active AS (
  SELECT v.source, count(*)::int AS n FROM vessel_latest v, m
  WHERE v.time >= m.minute + interval '1 minute' - make_interval(secs => $2::float8)
  GROUP BY v.source
)
INSERT INTO traffic_minutes (minute, source, messages, active_vessels)
SELECT m.minute, f.source, coalesce(recorded.n, 0), coalesce(active.n, 0)
FROM m CROSS JOIN unnest($3::text[]) AS f(source)
LEFT JOIN recorded ON recorded.source = f.source
LEFT JOIN active ON active.source = f.source
ON CONFLICT (minute, source) DO NOTHING
RETURNING minute`;

/** Sampled minutes grouped into buckets of `$1`, per feed, for `[$2, $3)`. */
const TRAFFIC_BUCKETS = `
SELECT time_bucket($1::interval, minute) AS at, source,
       count(*)::int AS samples,
       sum(messages)::int AS messages,
       last(active_vessels, minute) AS active_vessels
FROM traffic_minutes
WHERE minute >= $2 AND minute < $3
GROUP BY 1, 2
ORDER BY 1, 2`;

interface BucketRow {
  readonly at: Date;
  readonly source: AisSource;
  readonly samples: number;
  readonly messages: number;
  readonly active_vessels: number;
}

/** Aggregates of `GET /ais/stats` and its history. */
@Injectable()
export class StatsRepository {
  constructor(
    @InjectDb() private readonly db: Database<typeof schema>,
    @InjectPool() private readonly pool: Pool,
  ) {}

  /** Vessels whose latest position is at or after `since`, by the feed of that position. */
  async activeVessels(since: Date): Promise<CountsBySource> {
    const rows = await this.db
      .select({ source: vesselLatest.source, count: count() })
      .from(vesselLatest)
      .where(gte(vesselLatest.time, since))
      .groupBy(vesselLatest.source);
    return new Map(rows.map((row) => [row.source, row.count]));
  }

  /** Positions recorded with a position time at or after `since`, by feed. */
  async recordedPositions(since: Date): Promise<CountsBySource> {
    const rows = await this.db
      .select({ source: positions.source, count: count() })
      .from(positions)
      .where(gte(positions.time, since))
      .groupBy(positions.source);
    return new Map(rows.map((row) => [row.source, row.count]));
  }

  /**
   * Samples `minute` (default: the last completed minute by the database
   * clock) for every feed in `sources`.
   *
   * @returns whether this call recorded it (`false`: already sampled)
   */
  async sampleMinute(options: {
    readonly minute?: Date | undefined;
    readonly activeWindowMs: number;
    readonly sources: readonly AisSource[];
  }): Promise<boolean> {
    const { rowCount } = await this.pool.query(SAMPLE_MINUTE, [
      options.minute?.toISOString() ?? null,
      options.activeWindowMs / 1000,
      options.sources,
    ]);
    return (rowCount ?? 0) > 0;
  }

  /** Sampled minutes of `[from, to)` in buckets of `bucket` (a PostgreSQL interval), per feed, in time order. */
  async trafficBuckets(
    bucket: string,
    from: Date,
    to: Date,
  ): Promise<TrafficBucketRow[]> {
    const { rows } = await this.pool.query<BucketRow>(TRAFFIC_BUCKETS, [
      bucket,
      from.toISOString(),
      to.toISOString(),
    ]);
    return rows.map((row) => ({
      at: row.at,
      source: row.source,
      samples: row.samples,
      messages: row.messages,
      activeVessels: row.active_vessels,
    }));
  }
}
