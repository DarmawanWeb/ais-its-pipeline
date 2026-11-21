import type { AisSource } from '@darmawanweb/ais-its-contracts/domain';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { count, gte } from 'drizzle-orm';

import * as schema from '../db/schema.js';

const { positions, vesselLatest } = schema;

/** Counts per feed. */
export type CountsBySource = ReadonlyMap<AisSource, number>;

/** Aggregates of `GET /ais/stats`. */
@Injectable()
export class StatsRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

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
}
