import type { AisSource, BBox } from '@darmawanweb/ais-its-contracts/domain';
import {
  type Database,
  geographyIntersectsBBox,
  InjectDb,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import * as schema from '../db/schema.js';
import type { TrackPoint, VesselLatest } from './positions.model.js';

const { positions, positions1m, vesselLatest, vesselRefs } = schema;

/** Filters of the latest positions. */
export interface LatestFilter {
  /** Latest position at or after this time; `undefined` = any age. */
  readonly since: Date | undefined;
  readonly bbox: BBox | undefined;
  /** Only these vessels (`undefined` = all). */
  readonly mmsis?: readonly number[] | undefined;
  readonly limit: number;
}

/** A time range of one vessel, with a row limit. */
export interface TrackRange {
  readonly mmsi: number;
  readonly from: Date;
  readonly to: Date;
  readonly limit: number;
}

const latestColumns = {
  mmsi: vesselLatest.mmsi,
  time: vesselLatest.time,
  lat: vesselLatest.lat,
  lon: vesselLatest.lon,
  sog: vesselLatest.sog,
  cog: vesselLatest.cog,
  hdg: vesselLatest.hdg,
  navstatus: vesselLatest.navstatus,
  predNavstatus: vesselLatest.predNavstatus,
  source: vesselLatest.source,
  vesselId: vesselRefs.vesselId,
  vesselName: vesselRefs.name,
  typeCode: vesselRefs.typeCode,
};

/** A row of {@link latestColumns} (the FLEET columns are null without a projection row). */
interface LatestRow {
  readonly mmsi: number;
  readonly time: Date;
  readonly lat: number;
  readonly lon: number;
  readonly sog: number;
  readonly cog: number;
  readonly hdg: number;
  readonly navstatus: number;
  readonly predNavstatus: number;
  readonly source: AisSource;
  readonly vesselId: string | null;
  readonly vesselName: string | null;
  readonly typeCode: string | null;
}

function toLatest(row: LatestRow): VesselLatest {
  return {
    mmsi: row.mmsi,
    time: row.time,
    lat: row.lat,
    lon: row.lon,
    sog: row.sog,
    cog: row.cog,
    hdg: row.hdg,
    navstatus: row.navstatus,
    predictedNavstatus: row.predNavstatus === 1 ? 1 : 0,
    source: row.source,
    vessel:
      row.vesselId === null || row.vesselName === null
        ? null
        : { id: row.vesselId, name: row.vesselName, typeCode: row.typeCode },
  };
}

/** Read side of the AIS data (shared across tenants, spec §8.5). */
@Injectable()
export class PositionsRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /**
   * Latest positions, newest first (GiST index on `geom::geometry` for the
   * bbox, the primary key for `mmsis`).
   */
  async latest(filter: LatestFilter): Promise<VesselLatest[]> {
    const rows = await this.db
      .select(latestColumns)
      .from(vesselLatest)
      .leftJoin(vesselRefs, eq(vesselRefs.mmsi, vesselLatest.mmsi))
      .where(
        and(
          filter.since === undefined
            ? undefined
            : gte(vesselLatest.time, filter.since),
          filter.mmsis === undefined
            ? undefined
            : inArray(vesselLatest.mmsi, [...filter.mmsis]),
          filter.bbox === undefined
            ? undefined
            : geographyIntersectsBBox(vesselLatest.geom, filter.bbox),
        ),
      )
      .orderBy(desc(vesselLatest.time))
      .limit(filter.limit);
    return rows.map(toLatest);
  }

  async latestOf(mmsi: number): Promise<VesselLatest | null> {
    const [row] = await this.db
      .select(latestColumns)
      .from(vesselLatest)
      .leftJoin(vesselRefs, eq(vesselRefs.mmsi, vesselLatest.mmsi))
      .where(eq(vesselLatest.mmsi, mmsi))
      .limit(1);
    return row === undefined ? null : toLatest(row);
  }

  /** The newest `limit` raw positions of the range, in time order. */
  async rawTrack(range: TrackRange): Promise<TrackPoint[]> {
    const rows = await this.db
      .select({
        time: positions.time,
        lat: sql<number>`ST_Y(${positions.geom}::geometry)`,
        lon: sql<number>`ST_X(${positions.geom}::geometry)`,
        sog: positions.sog,
        cog: positions.cog,
        hdg: positions.hdg,
        navstatus: positions.navstatus,
        predNavstatus: positions.predNavstatus,
        source: positions.source,
      })
      .from(positions)
      .where(
        and(
          eq(positions.mmsi, range.mmsi),
          gte(positions.time, range.from),
          lte(positions.time, range.to),
        ),
      )
      .orderBy(desc(positions.time))
      .limit(range.limit);
    return rows.reverse().map(({ predNavstatus, ...row }) => ({
      ...row,
      predictedNavstatus: predNavstatus === 1 ? 1 : 0,
    }));
  }

  /** The newest `limit` one-minute buckets of the range (continuous aggregate, real-time), in time order. */
  async minuteTrack(range: TrackRange): Promise<TrackPoint[]> {
    const rows = await this.db
      .select({
        time: positions1m.bucket,
        lat: sql<number>`ST_Y(${positions1m.geom}::geometry)`,
        lon: sql<number>`ST_X(${positions1m.geom}::geometry)`,
        sog: positions1m.sog,
        sogAvg: positions1m.sogAvg,
        sogMax: positions1m.sogMax,
        cog: positions1m.cog,
        hdg: positions1m.hdg,
        navstatus: positions1m.navstatus,
        predNavstatus: positions1m.predNavstatus,
        source: positions1m.source,
        samples: positions1m.samples,
      })
      .from(positions1m)
      .where(
        and(
          eq(positions1m.mmsi, range.mmsi),
          gte(positions1m.bucket, range.from),
          lte(positions1m.bucket, range.to),
        ),
      )
      .orderBy(desc(positions1m.bucket))
      .limit(range.limit);
    return rows
      .reverse()
      .map(({ predNavstatus, samples, sogAvg, sogMax, ...row }) => ({
        ...row,
        predictedNavstatus: predNavstatus === 1 ? 1 : 0,
        minute: { samples, sogAvg, sogMax },
      }));
  }
}
