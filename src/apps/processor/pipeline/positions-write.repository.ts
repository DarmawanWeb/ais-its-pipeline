import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import {
  InjectPool,
  type Pool,
  type PoolClient,
  withTransaction,
} from '@darmawanweb/ais-its-nest/db';
import { enqueueEvent } from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';

import { positionEventId } from '../../../shared/domain/event-id.js';
import {
  type RecordedPosition,
  toPositionRecorded,
} from './recorded-position.js';
import {
  type PositionRow,
  resolveBatch,
  type RowResolution,
} from './resolve-batch.js';

/**
 * First key of the transaction-scoped advisory locks that serialize the
 * first positions of a vessel without a `vessel_latest` row (no row to
 * lock yet); the second key is the MMSI. ASCII "AIS1".
 */
export const NEW_VESSEL_LOCK_NAMESPACE = 0x41_49_53_31;

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

/** Locks (in MMSI order, so concurrent batches never deadlock) and reads latest positions. */
const LOCK_LATEST = `
SELECT mmsi, time, source, lat, lon, sog, cog, hdg, navstatus, pred_navstatus, coast_dist_m
FROM vessel_latest WHERE mmsi = ANY($1::integer[])
ORDER BY mmsi FOR UPDATE`;

/** Advisory locks of vessels without a latest row, taken in the (sorted) array order. */
const LOCK_NEW_VESSELS = `SELECT pg_advisory_xact_lock(${NEW_VESSEL_LOCK_NAMESPACE}, m) FROM unnest($1::integer[]) AS m`;

interface LatestRow {
  readonly mmsi: number;
  readonly time: Date;
  readonly source: RecordedPosition['source'];
  readonly lat: number;
  readonly lon: number;
  readonly sog: number;
  readonly cog: number;
  readonly hdg: number;
  readonly navstatus: number;
  readonly pred_navstatus: number;
  readonly coast_dist_m: number | null;
}

function toRecorded(row: LatestRow): RecordedPosition {
  return {
    mmsi: row.mmsi,
    time: row.time,
    source: row.source,
    lat: row.lat,
    lon: row.lon,
    sog: row.sog,
    cog: row.cog,
    hdg: row.hdg,
    navstatus: row.navstatus,
    predictedNavstatus: row.pred_navstatus === 1 ? 1 : 0,
    coastDistanceM: row.coast_dist_m,
  };
}

/** Vessels with a candidate latest position in the batch, ascending (lock order). */
export function candidateVessels(rows: readonly PositionRow[]): number[] {
  const mmsis = new Set<number>();
  for (const row of rows) if (row.latest) mmsis.add(row.position.mmsi);
  return [...mmsis].sort((a, b) => a - b);
}

/**
 * Batched, idempotent writes of the processor, in ONE transaction per batch:
 *
 * 1. the stored latest positions of the batch's vessels are locked and read
 *    (`FOR UPDATE`; an advisory lock for vessels without one) — they are
 *    authoritative over the processor's in-memory and Valkey state;
 * 2. the batch is resolved against them ({@link resolveBatch}): which
 *    candidates become the latest position, their `previous` links and
 *    predicted navstatus;
 * 3. `positions` rows are inserted (`ON CONFLICT DO NOTHING`: redeliveries,
 *    the same report of another feed), `vessel_latest` is upserted (never
 *    replaced by an older position), and the `ais.position.recorded.v1`
 *    event of every recorded position is enqueued in the transactional
 *    outbox (kit `enqueueEvent`, envelope id = {@link positionEventId}).
 *
 * The rows and their events commit or roll back together, so an event can
 * never be lost once its position is stored. An event is enqueued only for
 * a position that becomes newer than the stored latest one, which happens
 * once per position: its id cannot collide. Deadlocks and serialization
 * failures re-run the whole transaction (state re-read).
 */
@Injectable()
export class PositionsWriteRepository {
  constructor(@InjectPool() private readonly pool: Pool) {}

  /** Writes a batch; resolves with one {@link RowResolution} per row, in row order. */
  async writeBatch(
    rows: readonly PositionRow[],
  ): Promise<readonly RowResolution[]> {
    if (rows.length === 0) return [];
    return withTransaction(
      this.pool,
      async (client: PoolClient) => {
        const stored = await this.lockLatest(client, candidateVessels(rows));
        const resolution = resolveBatch(rows, stored);
        await client.query(INSERT_POSITIONS, columns(resolution.rows));
        if (resolution.latest.length > 0)
          await client.query(UPSERT_LATEST, columns(resolution.latest));
        for (const { position, previous } of resolution.events) {
          await enqueueEvent(
            client,
            EVENT_TYPES.AIS_POSITION_RECORDED,
            toPositionRecorded(position, previous),
            { id: positionEventId(position.mmsi, position.time) },
          );
        }
        return resolution.results;
      },
      { retries: 2 },
    );
  }

  /**
   * Locks and reads the latest positions of `mmsis` (ascending). A vessel
   * without a latest row has nothing to lock: its first positions are
   * serialized by an advisory lock, then the row is read again (another
   * transaction may have created it meanwhile).
   */
  private async lockLatest(
    client: PoolClient,
    mmsis: readonly number[],
  ): Promise<Map<number, RecordedPosition>> {
    const found = new Map<number, RecordedPosition>();
    if (mmsis.length === 0) return found;
    const read = async (ids: readonly number[]): Promise<void> => {
      const { rows } = await client.query<LatestRow>(LOCK_LATEST, [ids]);
      for (const row of rows) found.set(row.mmsi, toRecorded(row));
    };
    await read(mmsis);
    const missing = mmsis.filter((mmsi) => !found.has(mmsi));
    if (missing.length > 0) {
      await client.query(LOCK_NEW_VESSELS, [missing]);
      await read(missing);
    }
    return found;
  }
}
