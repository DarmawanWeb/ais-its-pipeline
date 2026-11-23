// Drizzle definitions of the "ais" schema (docs/PLATFORM_SPEC.md §6). The SQL
// files in migrations/ create the objects; these definitions MUST mirror them
// and only type the queries.
import { geography } from '@darmawanweb/ais-its-nest/db';
import { sql } from 'drizzle-orm';
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

/**
 * Transactional outbox of `ais.position.recorded.v1` (`0003_outbox.sql`,
 * upgraded for the kit's per-key relay by `0004_outbox_per_key.sql`): written
 * by the position batches, read and published by the kit's `OutboxRelay`
 * (entity key = MMSI, `seq` order per vessel).
 */
export const outbox = serviceSchema.table(
  'outbox',
  {
    id: pg.uuid('id').primaryKey(),
    seq: pg
      .bigint('seq', { mode: 'number' })
      .notNull()
      .generatedByDefaultAsIdentity(),
    type: pg.text('type').notNull(),
    entityKey: pg.text('entity_key'),
    data: pg.jsonb('data').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    attempts: pg.integer('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at'),
    lastError: pg.text('last_error'),
    publishedAt: timestamptz('published_at'),
    failedAt: timestamptz('failed_at'),
  },
  (table) => [
    pg.unique('outbox_seq_key').on(table.seq),
    pg
      .index('outbox_pending_idx')
      .on(table.createdAt, table.id)
      .where(sql`published_at IS NULL AND failed_at IS NULL`),
    pg
      .index('outbox_pending_seq_idx')
      .on(table.seq)
      .where(sql`published_at IS NULL AND failed_at IS NULL`),
    pg
      .index('outbox_pending_key_idx')
      .on(table.entityKey, table.seq)
      .where(sql`published_at IS NULL AND failed_at IS NULL`),
    pg
      .index('outbox_retry_idx')
      .on(table.entityKey, table.seq)
      .where(
        sql`published_at IS NULL AND failed_at IS NULL AND next_attempt_at IS NOT NULL`,
      ),
    pg
      .index('outbox_failed_idx')
      .on(table.failedAt)
      .where(sql`failed_at IS NOT NULL`),
  ],
);

/**
 * Traffic counters per minute and feed, the sampled history of
 * `GET /ais/stats` (hypertable, `0005_traffic_minutes.sql`).
 */
export const trafficMinutes = serviceSchema.table(
  'traffic_minutes',
  {
    minute: timestamptz('minute').notNull(),
    source: pg
      .text('source', { enum: ['primary', 'batam', 'pusher'] })
      .notNull(),
    messages: pg.integer('messages').notNull(),
    activeVessels: pg.integer('active_vessels').notNull(),
    sampledAt: timestamptz('sampled_at').notNull().defaultNow(),
  },
  (table) => [pg.primaryKey({ columns: [table.minute, table.source] })],
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
