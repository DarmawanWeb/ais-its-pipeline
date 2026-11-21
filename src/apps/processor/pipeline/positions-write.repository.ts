import {
  InjectPool,
  type Pool,
  type PoolClient,
  withTransaction,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';

import type { RecordedPosition } from './recorded-position.js';

/** A row of a write batch: the position, and whether it is the vessel's new latest one. */
export interface PositionRow {
  readonly position: RecordedPosition;
  /** `false` for out-of-order reports: stored, never the latest state. */
  readonly latest: boolean;
}

/** Column arrays of `unnest()` (one bound parameter per column). */
function columns(positions: readonly RecordedPosition[]) {
  return [
    positions.map((p) => p.time.toISOString()),
    positions.map((p) => p.mmsi),
    positions.map((p) => p.source),
    positions.map((p) => p.lon),
    positions.map((p) => p.lat),
    positions.map((p) => p.sog),
    positions.map((p) => p.cog),
    positions.map((p) => p.hdg),
    positions.map((p) => p.navstatus),
    positions.map((p) => p.predictedNavstatus),
    positions.map((p) => p.coastDistanceM),
  ];
}

const UNNEST = `unnest($1::timestamptz[], $2::integer[], $3::text[], $4::float8[], $5::float8[],
  $6::float8[], $7::float8[], $8::float8[], $9::smallint[], $10::smallint[], $11::float8[])
  AS r(time, mmsi, source, lon, lat, sog, cog, hdg, navstatus, pred_navstatus, coast_dist_m)`;

const INSERT_POSITIONS = `
INSERT INTO positions (time, mmsi, source, geom, sog, cog, hdg, navstatus, pred_navstatus, coast_dist_m)
SELECT r.time, r.mmsi, r.source, ST_SetSRID(ST_MakePoint(r.lon, r.lat), 4326)::geography,
       r.sog, r.cog, r.hdg, r.navstatus, r.pred_navstatus, r.coast_dist_m
FROM ${UNNEST}
ORDER BY r.mmsi, r.time
ON CONFLICT (mmsi, time) DO NOTHING`;

const UPSERT_LATEST = `
INSERT INTO vessel_latest (mmsi, time, source, lat, lon, geom, sog, cog, hdg, navstatus, pred_navstatus, coast_dist_m, updated_at)
SELECT r.mmsi, r.time, r.source, r.lat, r.lon, ST_SetSRID(ST_MakePoint(r.lon, r.lat), 4326)::geography,
       r.sog, r.cog, r.hdg, r.navstatus, r.pred_navstatus, r.coast_dist_m, now()
FROM ${UNNEST}
ORDER BY r.mmsi
ON CONFLICT (mmsi) DO UPDATE SET
  time = EXCLUDED.time, source = EXCLUDED.source, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
  geom = EXCLUDED.geom, sog = EXCLUDED.sog, cog = EXCLUDED.cog, hdg = EXCLUDED.hdg,
  navstatus = EXCLUDED.navstatus, pred_navstatus = EXCLUDED.pred_navstatus,
  coast_dist_m = EXCLUDED.coast_dist_m, updated_at = now()
WHERE vessel_latest.time < EXCLUDED.time`;

/**
 * The newest position per vessel among the batch's latest rows (one upsert
 * may not touch a row twice).
 */
export function latestPerVessel(
  rows: readonly PositionRow[],
): RecordedPosition[] {
  const latest = new Map<number, RecordedPosition>();
  for (const { position, latest: isLatest } of rows) {
    if (!isLatest) continue;
    const current = latest.get(position.mmsi);
    if (current === undefined || current.time < position.time)
      latest.set(position.mmsi, position);
  }
  return [...latest.values()];
}

/**
 * Batched, idempotent writes of the processor: `positions` rows with
 * `ON CONFLICT DO NOTHING` (redeliveries, duplicates of another feed) and the
 * `vessel_latest` upsert, which never replaces a newer position, in ONE
 * transaction. Rows are sorted by vessel so concurrent batches lock in the
 * same order; deadlocks and serialization failures are retried.
 */
@Injectable()
export class PositionsWriteRepository {
  constructor(@InjectPool() private readonly pool: Pool) {}

  async writeBatch(rows: readonly PositionRow[]): Promise<void> {
    if (rows.length === 0) return;
    const positions = rows.map((row) => row.position);
    const latest = latestPerVessel(rows);
    await withTransaction(
      this.pool,
      async (client: PoolClient) => {
        await client.query(INSERT_POSITIONS, columns(positions));
        if (latest.length > 0)
          await client.query(UPSERT_LATEST, columns(latest));
      },
      { retries: 2 },
    );
  }
}
