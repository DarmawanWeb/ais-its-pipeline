// Drizzle definitions of the "ais" schema (docs/PLATFORM_SPEC.md §6). The SQL
// files in migrations/ create the objects; these definitions MUST mirror them
// and only type the queries.
import { geography } from '@darmawanweb/ais-its-nest/db';
import * as pg from 'drizzle-orm/pg-core';

/** The processor's PostgreSQL schema, owned by the role `ais_svc`. */
export const serviceSchema = pg.pgSchema('ais');

const timestamptz = (name: string) =>
  pg.timestamp(name, { withTimezone: true, mode: 'date' });

/** Recorded AIS positions (hypertable, `0001_init.sql`). */
export const positions = serviceSchema.table(
  'positions',
  {
    time: timestamptz('time').notNull(),
    mmsi: pg.integer('mmsi').notNull(),
    source: pg
      .text('source', { enum: ['primary', 'batam', 'pusher'] })
      .notNull(),
    geom: geography('geom', { subtype: 'Point' }).notNull(),
    sog: pg.doublePrecision('sog').notNull(),
    cog: pg.doublePrecision('cog').notNull(),
    hdg: pg.doublePrecision('hdg').notNull(),
    navstatus: pg.smallint('navstatus').notNull(),
    predNavstatus: pg.smallint('pred_navstatus').notNull(),
    coastDistM: pg.doublePrecision('coast_dist_m'),
  },
  (table) => [pg.primaryKey({ columns: [table.mmsi, table.time] })],
);

/** Latest position per vessel (`0001_init.sql`). */
export const vesselLatest = serviceSchema.table(
  'vessel_latest',
  {
    mmsi: pg.integer('mmsi').primaryKey(),
    time: timestamptz('time').notNull(),
    source: pg
      .text('source', { enum: ['primary', 'batam', 'pusher'] })
      .notNull(),
    lat: pg.doublePrecision('lat').notNull(),
    lon: pg.doublePrecision('lon').notNull(),
    geom: geography('geom', { subtype: 'Point' }).notNull(),
    sog: pg.doublePrecision('sog').notNull(),
    cog: pg.doublePrecision('cog').notNull(),
    hdg: pg.doublePrecision('hdg').notNull(),
    navstatus: pg.smallint('navstatus').notNull(),
    predNavstatus: pg.smallint('pred_navstatus').notNull(),
    coastDistM: pg.doublePrecision('coast_dist_m'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [pg.index('vessel_latest_time_idx').on(table.time.desc())],
);

/** FLEET projection: vessel identity by MMSI (`0001_init.sql`). */
export const vesselRefs = serviceSchema.table(
  'vessel_refs',
  {
    mmsi: pg.integer('mmsi').primaryKey(),
    vesselId: pg.uuid('vessel_id').notNull(),
    name: pg.text('name').notNull(),
    typeCode: pg.text('type_code'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [pg.unique('vessel_refs_vessel_id_key').on(table.vesselId)],
);

/** One-minute continuous aggregate of `positions` (`0002_positions_1m.sql`). */
export const positions1m = serviceSchema
  .materializedView('positions_1m', {
    bucket: timestamptz('bucket').notNull(),
    mmsi: pg.integer('mmsi').notNull(),
    geom: geography('geom', { subtype: 'Point' }).notNull(),
    sog: pg.doublePrecision('sog').notNull(),
    sogAvg: pg.doublePrecision('sog_avg').notNull(),
    sogMax: pg.doublePrecision('sog_max').notNull(),
    cog: pg.doublePrecision('cog').notNull(),
    hdg: pg.doublePrecision('hdg').notNull(),
    navstatus: pg.smallint('navstatus').notNull(),
    predNavstatus: pg.smallint('pred_navstatus').notNull(),
    source: pg
      .text('source', { enum: ['primary', 'batam', 'pusher'] })
      .notNull(),
    samples: pg.bigint('samples', { mode: 'number' }).notNull(),
    lastTime: timestamptz('last_time').notNull(),
  })
  .existing();
