import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import * as schema from '../db/schema.js';
import type { RecordedPosition } from './recorded-position.js';

const { vesselLatest } = schema;

/** Reads the durable latest position of a vessel (fallback behind Valkey). */
@Injectable()
export class VesselLatestRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  async find(mmsi: number): Promise<RecordedPosition | null> {
    const [row] = await this.db
      .select({
        mmsi: vesselLatest.mmsi,
        time: vesselLatest.time,
        source: vesselLatest.source,
        lat: vesselLatest.lat,
        lon: vesselLatest.lon,
        sog: vesselLatest.sog,
        cog: vesselLatest.cog,
        hdg: vesselLatest.hdg,
        navstatus: vesselLatest.navstatus,
        predNavstatus: vesselLatest.predNavstatus,
        coastDistM: vesselLatest.coastDistM,
      })
      .from(vesselLatest)
      .where(eq(vesselLatest.mmsi, mmsi))
      .limit(1);
    if (row === undefined) return null;
    const { predNavstatus, coastDistM, ...rest } = row;
    return {
      ...rest,
      predictedNavstatus: predNavstatus === 1 ? 1 : 0,
      coastDistanceM: coastDistM,
    };
  }
}
