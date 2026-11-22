import { readFile } from 'node:fs/promises';

import {
  type AisPositionRecordedV1,
  EVENT_TYPES,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { APP_CONFIG } from '@darmawanweb/ais-its-nest';
import { makeTestVesselSnapshot } from '@darmawanweb/ais-its-nest/analytics';
import { EventPublisher, NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { REDIS_CLIENT, type Redis } from '@darmawanweb/ais-its-nest/redis';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoastlineService } from '../src/apps/processor/coastline/coastline.service.js';
import type { ProcessorConfig } from '../src/apps/processor/config.js';
import { LastPositionStore } from '../src/apps/processor/pipeline/last-position.store.js';
import { PipelineMetrics } from '../src/apps/processor/pipeline/pipeline.metrics.js';
import { PositionPipelineService } from '../src/apps/processor/pipeline/position-pipeline.service.js';
import { PositionWriter } from '../src/apps/processor/pipeline/position-writer.js';
import { LEGACY_GOLDENS } from '../src/shared/domain/__fixtures__/legacy-goldens.js';
import { positionEventId } from '../src/shared/domain/event-id.js';
import { calculatePredictedNavStatus } from '../src/shared/domain/navstatus.js';
import { moved, normalizedMessage } from './support/messages.js';
import {
  purgeStreams,
  readEvents,
  resetProcessorSchema,
  startIngestor,
  startProcessor,
  startTestAuth,
  type TestAuth,
  type TestIngestor,
  type TestProcessor,
} from './support/test-apps.js';

const MOVING = 525005201;
const ANCHORED = 525005202;
const UNPUBLISHED = 525005203;
const SHARED = 525005204;

/** A whole second ten minutes ago (position times of this file). */
const T0 = new Date(Math.floor(Date.now() / 1000) * 1000 - 10 * 60_000);
const at = (offsetS: number): Date => new Date(T0.getTime() + offsetS * 1000);

/** The madura-strait golden point of the legacy coast distance. */
const MADURA = LEGACY_GOLDENS.coast.find(
  (golden) => golden.name === 'madura-strait',
);

interface PositionRow {
  time: Date;
  lat: number;
  lon: number;
  sog: number;
  pred_navstatus: number;
  coast_dist_m: number | null;
  source: string;
}

async function positionsOf(
  processor: TestProcessor,
  mmsi: number,
): Promise<PositionRow[]> {
  const { rows } = await processor.pool.query<PositionRow>(
    `SELECT time, ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon, sog,
            pred_navstatus, coast_dist_m, source
     FROM positions WHERE mmsi = $1 ORDER BY time`,
    [mmsi],
  );
  return rows;
}

async function latestOf(
  processor: TestProcessor,
  mmsi: number,
): Promise<{ time: Date; lat: number; lon: number } | undefined> {
  const { rows } = await processor.pool.query<{
    time: Date;
    lat: number;
    lon: number;
  }>('SELECT time, lat, lon FROM vessel_latest WHERE mmsi = $1', [mmsi]);
  return rows[0];
}

async function positionEvents(
  processor: TestProcessor,
  mmsi: number,
): Promise<{ id: string; source: string; data: AisPositionRecordedV1 }[]> {
  const stored = await readEvents(processor.app, {
    stream: 'AIS_POSITION',
    filterSubjects: [subjects.aisPosition(mmsi)],
    eventTypes: [EVENT_TYPES.AIS_POSITION_RECORDED],
    from: new Date(0),
  });
  return stored.flatMap(({ event }) =>
    event.type === EVENT_TYPES.AIS_POSITION_RECORDED
      ? [{ id: event.id, source: event.source, data: event.data }]
      : [],
  );
}

/** Waits until the processor's durable consumer has settled every raw report. */
async function drained(processor: TestProcessor): Promise<void> {
  const { manager } = await processor.app.get(NatsClient).ready();
  const durable = `${processor.config.NATS_DURABLE_PREFIX}ais-processor`;
  await waitFor(
    async () => {
      const info = await manager.consumers.info('AIS_RAW', durable);
      return info.num_pending === 0 && info.num_ack_pending === 0;
    },
    { timeoutMs: 20_000 },
  );
}

function metric(body: string, pattern: RegExp): number {
  return Number(pattern.exec(body)?.[1] ?? 0);
}

describe('processor: AIS_RAW → positions, vessel_latest, Valkey, AIS_POSITION', () => {
  let auth: TestAuth;
  let ingestor: TestIngestor;
  let processor: TestProcessor;
  let databaseUrl: string;
  let ingestKey: string;

  async function ingest(messages: unknown[]): Promise<void> {
    const response = await ingestor.app.inject({
      method: 'POST',
      url: '/api/v2/ingest/ais',
      headers: { 'x-api-key': ingestKey },
      payload: messages,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ rejected: 0 });
  }

  beforeAll(async () => {
    auth = await startTestAuth();
    ingestKey = auth.apiKey(['ais:ingest']);
    ingestor = await startIngestor(auth);
    // Earlier files' reports must not be replayed into this file's schema.
    await purgeStreams(ingestor.app, ['AIS_RAW', 'AIS_POSITION']);
    databaseUrl = await resetProcessorSchema();
    processor = await startProcessor(auth, databaseUrl);
  });

  afterAll(async () => {
    await processor.app.close();
    await ingestor.app.close();
    await auth.close();
  });

  it('is ready with PostgreSQL, NATS and Valkey; migrations created the hypertable, its policies and the 1-minute aggregate', async () => {
    const ready = await processor.app.inject({ url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      details: {
        database: { status: 'up' },
        nats: { status: 'up' },
        redis: { status: 'up' },
      },
    });

    const migrations = await processor.pool.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY version',
    );
    expect(migrations.rows.map((row) => row.name)).toEqual([
      'init',
      'positions_1m',
      'outbox',
    ]);

    const hypertables = await processor.pool.query<{
      hypertable_name: string;
      compression_enabled: boolean;
    }>(
      `SELECT hypertable_name, compression_enabled
       FROM timescaledb_information.hypertables WHERE hypertable_schema = 'ais'`,
    );
    expect(hypertables.rows).toEqual([
      { hypertable_name: 'positions', compression_enabled: true },
    ]);

    const jobs = await processor.pool.query<{
      owner: string;
      proc_name: string;
      config: Record<string, unknown>;
    }>(
      // TimescaleDB 2.2x lists continuous aggregate policies under the view name.
      `SELECT hypertable_name AS owner, proc_name, config
       FROM timescaledb_information.jobs
       WHERE hypertable_schema = 'ais'
       ORDER BY hypertable_name, proc_name`,
    );
    const setting = (config: Record<string, unknown>): unknown =>
      config.compress_after ?? config.drop_after ?? config.start_offset;
    expect(
      jobs.rows.map((job) => [job.owner, job.proc_name, setting(job.config)]),
    ).toEqual([
      ['positions', 'policy_compression', '3 days'],
      ['positions', 'policy_retention', '180 days'],
      ['positions_1m', 'policy_compression', '7 days'],
      ['positions_1m', 'policy_refresh_continuous_aggregate', '2 days'],
      ['positions_1m', 'policy_retention', '5 years'],
    ]);
  });

  it('completes migration 0002 when it runs again after a partial apply (its no-transaction statements are idempotent)', async () => {
    // A boot killed after the aggregate and its refresh policy were created.
    await processor.pool.query(
      `SELECT remove_retention_policy('positions_1m')`,
    );
    await processor.pool.query(
      `SELECT remove_compression_policy('positions_1m')`,
    );
    const migration = await readFile(
      new URL('../migrations/0002_positions_1m.sql', import.meta.url),
      'utf8',
    );
    const statements = migration
      .split(/;\s*$/m)
      .filter((chunk) =>
        chunk
          .split('\n')
          .some((line) => line.trim() !== '' && !line.trim().startsWith('--')),
      );
    expect(statements.length).toBeGreaterThanOrEqual(6);
    // The next boot re-runs every statement, as the kit's migrator does.
    for (const statement of statements) await processor.pool.query(statement);

    const jobs = await processor.pool.query<{ proc_name: string }>(
      `SELECT proc_name FROM timescaledb_information.jobs
       WHERE hypertable_schema = 'ais' AND hypertable_name = 'positions_1m'
       ORDER BY proc_name`,
    );
    expect(jobs.rows.map((job) => job.proc_name)).toEqual([
      'policy_compression',
      'policy_refresh_continuous_aggregate',
      'policy_retention',
    ]);
  });

  it('records the first and advancing reports, skips a duplicate movement < 0.1 m from the LATEST position and stores an out-of-order report without touching the latest state', async () => {
    const p0 = { lat: -7.2, lon: 112.75 };
    const p1 = moved(p0, 0, 120);
    const p2 = moved(p1, 0.03, 0.03); // ≈ 0.04 m from p1: skipped
    const pOld = moved(p0, 0, -100);
    const report = (time: Date, position: { lat: number; lon: number }) =>
      normalizedMessage({
        mmsi: MOVING,
        ...position,
        sog: 8,
        cog: 90,
        hdg: 92,
        timestamp: time,
      });
    await ingest([
      report(at(0), p0),
      report(at(30), p1),
      report(at(60), p2),
      report(at(-60), pOld),
    ]);

    const rows = await waitFor(async () => {
      const found = await positionsOf(processor, MOVING);
      return found.length === 3 ? found : null;
    });
    expect(rows.map((row) => row.time.toISOString())).toEqual([
      at(-60).toISOString(),
      at(0).toISOString(),
      at(30).toISOString(),
    ]);
    expect(rows[2]).toMatchObject({
      lat: p1.lat,
      lon: p1.lon,
      source: 'pusher',
    });

    await drained(processor);
    expect(await latestOf(processor, MOVING)).toEqual({
      time: at(30),
      lat: p1.lat,
      lon: p1.lon,
    });

    const events = await positionEvents(processor, MOVING);
    expect(events.map((event) => event.data.time)).toEqual([
      at(0).toISOString(),
      at(30).toISOString(),
    ]);
    expect(events[0]?.data.previous).toBeNull();
    expect(events[1]?.data.previous).toEqual({
      time: at(0).toISOString(),
      lat: p0.lat,
      lon: p0.lon,
      sog: 8,
      cog: 90,
      hdg: 92,
      navstatus: 0,
      predictedNavstatus: 0,
    });
    expect(events[1]).toMatchObject({
      id: positionEventId(MOVING, at(30)),
      source: 'ais-processor',
    });
    // No safety fields: EWS is computed by the safety service.
    expect(Object.keys(events[1]?.data ?? {}).sort()).toEqual(
      [
        'cog',
        'coastDistanceM',
        'hdg',
        'lat',
        'lon',
        'mmsi',
        'navstatus',
        'predictedNavstatus',
        'previous',
        'sog',
        'source',
        'time',
      ].sort(),
    );

    const redis = processor.app.get<unknown, Redis>(REDIS_CLIENT);
    expect(await redis.hgetall(`ais:last:${MOVING}`)).toMatchObject({
      time: at(30).toISOString(),
      lat: String(p1.lat),
      lon: String(p1.lon),
    });

    const metrics = (await processor.app.inject({ url: '/metrics' })).body;
    expect(
      metric(
        metrics,
        /aisits_ais_messages_total\{source="pusher",outcome="recorded"\} (\d+)/,
      ),
    ).toBe(2);
    expect(
      metric(
        metrics,
        /aisits_ais_messages_total\{source="pusher",outcome="stationary"\} (\d+)/,
      ),
    ).toBe(1);
    expect(
      metric(
        metrics,
        /aisits_ais_messages_total\{source="pusher",outcome="out_of_order"\} (\d+)/,
      ),
    ).toBe(1);
    expect(metrics).toContain('aisits_ais_ingest_lag_seconds_count');
  });

  it('computes the coast distance and the predicted navstatus with legacy parity (previous = latest position)', async () => {
    expect(MADURA).toBeDefined();
    const point = { lat: MADURA?.lat ?? 0, lon: MADURA?.lon ?? 0 };
    const anchored = { sog: 0.1, cog: 10, hdg: 12 };
    const underWay = { sog: 3, cog: 100, hdg: 50 };
    await ingest([
      normalizedMessage({
        mmsi: ANCHORED,
        ...point,
        ...anchored,
        navstatus: 1,
        timestamp: at(0),
      }),
      normalizedMessage({
        mmsi: ANCHORED,
        ...moved(point, 5, 0),
        ...underWay,
        navstatus: 1,
        timestamp: at(30),
      }),
    ]);

    const rows = await waitFor(async () => {
      const found = await positionsOf(processor, ANCHORED);
      return found.length === 2 ? found : null;
    });
    // Same metres, bit for bit, as legacy findNearestCoastDistance (turf 7.2.0).
    expect(rows[0]?.coast_dist_m).toBe(MADURA?.meters);
    expect(rows[0]?.pred_navstatus).toBe(
      calculatePredictedNavStatus(anchored, anchored, MADURA?.meters ?? 0),
    );
    expect(rows[0]?.pred_navstatus).toBe(1);
    expect(rows[1]?.pred_navstatus).toBe(
      calculatePredictedNavStatus(
        underWay,
        anchored,
        rows[1]?.coast_dist_m ?? 0,
      ),
    );
    expect(rows[1]?.pred_navstatus).toBe(0);

    await drained(processor);
    const events = await positionEvents(processor, ANCHORED);
    expect(
      events.map((event) => [
        event.data.predictedNavstatus,
        event.data.previous?.predictedNavstatus ?? null,
      ]),
    ).toEqual([
      [1, null],
      [0, 1],
    ]);
    expect(events[0]?.data.coastDistanceM).toBe(MADURA?.meters);
  });

  it('never loses the event of a committed position: the raw report is acknowledged with its event in the outbox, published once AIS_POSITION accepts messages again', async () => {
    const { manager } = await processor.app.get(NatsClient).ready();
    const original = await manager.streams.info('AIS_POSITION');
    expect(original.state.messages).toBeGreaterThan(0);
    // The reviewer's reproduction: the stream refuses every new message.
    await manager.streams.update('AIS_POSITION', {
      max_msgs: original.state.messages,
      discard: 'new',
    });
    try {
      // The first position of a new vessel (no Valkey state at all).
      await ingest([
        normalizedMessage({
          mmsi: UNPUBLISHED,
          lat: -7.1,
          lon: 112.9,
          sog: 6,
          cog: 45,
          hdg: 44,
          timestamp: at(0),
        }),
      ]);
      // Rows committed and the raw report acknowledged, the event pending in the outbox.
      await drained(processor);
      expect(await latestOf(processor, UNPUBLISHED)).toMatchObject({
        time: at(0),
      });
      const pending = await waitFor(async () => {
        const { rows } = await processor.pool.query<{
          attempts: number;
          published_at: Date | null;
        }>('SELECT attempts, published_at FROM outbox WHERE id = $1', [
          positionEventId(UNPUBLISHED, at(0)),
        ]);
        const row = rows[0];
        return row !== undefined && row.attempts > 0 ? row : null;
      });
      expect(pending.published_at).toBeNull();
      expect(await positionEvents(processor, UNPUBLISHED)).toEqual([]);
    } finally {
      await manager.streams.update('AIS_POSITION', {
        max_msgs: original.config.max_msgs,
        discard: original.config.discard,
      });
    }

    const [event] = await waitFor(
      async () => {
        const events = await positionEvents(processor, UNPUBLISHED);
        return events.length > 0 ? events : null;
      },
      { timeoutMs: 45_000 },
    );
    expect(event).toMatchObject({
      id: positionEventId(UNPUBLISHED, at(0)),
      source: 'ais-processor',
      data: { mmsi: UNPUBLISHED, time: at(0).toISOString(), previous: null },
    });
    const metrics = (await processor.app.inject({ url: '/metrics' })).body;
    expect(metrics).toMatch(
      /aisits_outbox_relayed_total\{type="ais\.position\.recorded\.v1",outcome="failed"\} [1-9]/,
    );
  });

  it('revalidates a cached state another replica superseded and resolves stale decisions against the stored latest position', async () => {
    // A second replica's pipeline: its own in-memory state, the same Valkey and database.
    const replica = new PositionPipelineService(
      processor.app.get(LastPositionStore),
      processor.app.get(PositionWriter),
      processor.app.get(CoastlineService),
      processor.app.get(PipelineMetrics),
      processor.app.get<unknown, ProcessorConfig>(APP_CONFIG),
    );
    const base = { lat: -7.3, lon: 112.8 };
    const message = (offsetS: number, northM: number) =>
      normalizedMessage({
        mmsi: SHARED,
        ...moved(base, northM, 0),
        sog: 7,
        cog: 0,
        hdg: 1,
        timestamp: at(offsetS),
      });
    const raw = (offsetS: number, northM: number) => ({
      source: 'pusher' as const,
      receivedAt: new Date().toISOString(),
      positionTime: at(offsetS).toISOString(),
      mmsi: SHARED,
      navstatus: 0,
      ...moved(base, northM, 0),
      sog: 7,
      cog: 0,
      hdg: 1,
      aisType: null,
      receiverPort: null,
    });
    const redis = processor.app.get<unknown, Redis>(REDIS_CLIENT);
    const valkeyTime = async () => redis.hget(`ais:last:${SHARED}`, 'time');

    // This instance records t=0 (cached in memory), the replica t=30.
    await ingest([message(0, 0)]);
    await drained(processor);
    expect(await replica.process(raw(30, 100))).toBe('recorded');
    // t=20 is older than the replica's position: out of order, no event.
    await ingest([message(20, 50)]);
    await drained(processor);
    await ingest([message(60, 200)]);
    await drained(processor);

    // The replica records t=90 and Valkey loses it: only the write can tell.
    expect(await replica.process(raw(90, 300))).toBe('recorded');
    await redis.del(`ais:last:${SHARED}`);
    await ingest([message(80, 250)]);
    await drained(processor);
    expect(await valkeyTime()).toBe(at(90).toISOString());
    await ingest([message(120, 400)]);
    await drained(processor);

    const events = await waitFor(async () => {
      const found = await positionEvents(processor, SHARED);
      return found.length === 5 ? found : null;
    });
    expect(
      events.map((event) => [
        event.data.time,
        event.data.previous?.time ?? null,
      ]),
    ).toEqual([
      [at(0).toISOString(), null],
      [at(30).toISOString(), at(0).toISOString()],
      [at(60).toISOString(), at(30).toISOString()],
      [at(90).toISOString(), at(60).toISOString()],
      [at(120).toISOString(), at(90).toISOString()],
    ]);
    // Every report is stored for the track; latest and Valkey never moved back.
    expect(
      (await positionsOf(processor, SHARED)).map((row) =>
        row.time.toISOString(),
      ),
    ).toEqual([0, 20, 30, 60, 80, 90, 120].map((s) => at(s).toISOString()));
    expect((await latestOf(processor, SHARED))?.time).toEqual(at(120));
    // A late save of an older position does not move Valkey back (monotonic).
    await processor.app.get(LastPositionStore).save({
      mmsi: SHARED,
      time: at(0),
      source: 'pusher',
      ...base,
      sog: 7,
      cog: 0,
      hdg: 1,
      navstatus: 0,
      predictedNavstatus: 0,
      coastDistanceM: null,
    });
    expect(await valkeyTime()).toBe(at(120).toISOString());

    const metrics = (await processor.app.inject({ url: '/metrics' })).body;
    expect(metrics).toMatch(
      /aisits_ais_state_revalidations_total\{result="stale"\} [1-9]/,
    );
    expect(metrics).toMatch(/aisits_ais_state_stale_decisions_total [1-9]/);
  });

  it('is idempotent: a fresh consumer replaying AIS_RAW changes neither rows, latest state nor events (each event committed with its rows)', async () => {
    const before = {
      moving: await positionsOf(processor, MOVING),
      anchored: await positionsOf(processor, ANCHORED),
      events: (await positionEvents(processor, MOVING)).length,
    };
    await processor.app.close();
    // A new durable prefix = a new consumer that replays the whole stream.
    processor = await startProcessor(auth, databaseUrl);
    await drained(processor);

    expect(await positionsOf(processor, MOVING)).toEqual(before.moving);
    expect(await positionsOf(processor, ANCHORED)).toEqual(before.anchored);
    expect((await latestOf(processor, MOVING))?.time).toEqual(at(30));
    expect(await positionEvents(processor, MOVING)).toHaveLength(before.events);
    const outbox = await processor.pool.query<{ count: string }>(
      `SELECT count(*) FROM outbox WHERE entity_key = $1 AND published_at IS NOT NULL`,
      [String(MOVING)],
    );
    expect(Number(outbox.rows[0]?.count)).toBe(before.events);
    const metrics = (await processor.app.inject({ url: '/metrics' })).body;
    expect(
      metric(
        metrics,
        /aisits_ais_messages_total\{source="pusher",outcome="recorded"\} (\d+)/,
      ),
    ).toBe(0);
    expect(metrics).toMatch(
      /aisits_ais_state_loads_total\{origin="valkey"\} [1-9]/,
    );
  });

  it('falls back to vessel_latest when Valkey lost the last position, and links previous to it', async () => {
    // Expired / lost hash, then a restart (empty in-memory cache).
    await processor.app
      .get<unknown, Redis>(REDIS_CLIENT)
      .del(`ais:last:${MOVING}`);
    await processor.app.close();
    processor = await startProcessor(auth, databaseUrl);
    await drained(processor);

    const latest = await latestOf(processor, MOVING);
    const next = moved(
      { lat: latest?.lat ?? 0, lon: latest?.lon ?? 0 },
      200,
      0,
    );
    await ingest([
      normalizedMessage({
        mmsi: MOVING,
        ...next,
        sog: 9,
        cog: 0,
        hdg: 2,
        timestamp: at(90),
      }),
    ]);
    const event = await waitFor(async () => {
      const events = await positionEvents(processor, MOVING);
      return events.find((e) => e.data.time === at(90).toISOString()) ?? null;
    });
    expect(event.data.previous).toMatchObject({
      time: at(30).toISOString(),
      lat: latest?.lat,
      lon: latest?.lon,
    });
    const metrics = (await processor.app.inject({ url: '/metrics' })).body;
    expect(metrics).toMatch(
      /aisits_ais_state_loads_total\{origin="database"\} [1-9]/,
    );
  });

  it('projects FLEET snapshots into vessel_refs (stale snapshots ignored, deletions applied)', async () => {
    const publisher = processor.app.get(EventPublisher);
    const snapshot = makeTestVesselSnapshot({
      mmsi: MOVING,
      name: 'KM Sinar Bahari',
      updatedAt: new Date().toISOString(),
    });
    await publisher.publishEvent(EVENT_TYPES.FLEET_VESSEL_UPSERTED, snapshot);
    const headers = await auth.bearer({ roles: ['viewer'] });
    const enriched = await waitFor(async () => {
      const response = await processor.app.inject({
        url: `/api/v2/ais/vessels/${MOVING}/latest`,
        headers,
      });
      const body = response.json<{ vessel?: { name: string } }>();
      return body.vessel === undefined ? null : body;
    });
    expect(enriched.vessel).toEqual({
      id: snapshot.id,
      name: 'KM Sinar Bahari',
      typeCode: snapshot.type.code,
    });

    // A redelivered older snapshot never overwrites a newer one.
    await publisher.publishEvent(EVENT_TYPES.FLEET_VESSEL_UPSERTED, {
      ...snapshot,
      name: 'Old name',
      updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    await publisher.publishEvent(EVENT_TYPES.FLEET_VESSEL_DELETED, {
      id: snapshot.id,
      mmsi: MOVING,
      orgId: null,
    });
    await waitFor(async () => {
      const { rows } = await processor.pool.query(
        'SELECT 1 FROM vessel_refs WHERE vessel_id = $1',
        [snapshot.id],
      );
      return rows.length === 0;
    });
    const plain = await processor.app.inject({
      url: `/api/v2/ais/vessels/${MOVING}/latest`,
      headers,
    });
    expect(plain.json()).not.toHaveProperty('vessel');
  });
});
