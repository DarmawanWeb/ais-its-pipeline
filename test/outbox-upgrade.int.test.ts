import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  EVENT_TYPES,
  type EventPayload,
  type EventType,
} from '@darmawanweb/ais-its-contracts/events';
import { type Pool, runMigrations } from '@darmawanweb/ais-its-nest/db';
import {
  enqueueEvent,
  type EventPublisher,
  OutboxRelay,
  type PublishOptions,
} from '@darmawanweb/ais-its-nest/nats';
import { createTestConfig, testInfra } from '@darmawanweb/ais-its-nest/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { processorConfigSchema } from '../src/apps/processor/config.js';
import { outboxModuleOptions } from '../src/apps/processor/pipeline/pipeline.module.js';
import {
  type RecordedPosition,
  toPositionRecorded,
} from '../src/apps/processor/pipeline/recorded-position.js';
import { positionEventId } from '../src/shared/domain/event-id.js';
import { SERVICE } from '../src/shared/service.js';
import { resetProcessorSchema } from './support/test-apps.js';

const FAILING = 525007001;
const HEALTHY = 525007002;
const T0 = Date.UTC(2026, 10, 22, 8, 0, 0);

function position(mmsi: number, second: number): RecordedPosition {
  return {
    mmsi,
    time: new Date(T0 + second * 1000),
    source: 'primary',
    lat: -7.2,
    lon: 112.7 + second / 10_000,
    sog: 8,
    cog: 90,
    hdg: 90,
    navstatus: 0,
    predictedNavstatus: 0,
    coastDistanceM: 1000,
  };
}

/** Records publications and fails the next `failuresLeft` ones of the vessels in `failing`. */
class RecordingPublisher {
  readonly published: { mmsi: number; time: string }[] = [];
  readonly failing = new Set<number>();
  failuresLeft = 0;

  async publishEvent<Type extends EventType>(
    _type: Type,
    data: EventPayload<Type>,
    _options: PublishOptions = {},
  ): Promise<void> {
    await sleep(Math.random() * 3);
    const { mmsi, time } = data as { mmsi: number; time: string };
    if (this.failing.has(mmsi) && this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error('maximum messages per subject exceeded');
    }
    this.published.push({ mmsi, time });
  }

  timesOf(mmsi: number): string[] {
    return this.published
      .filter((item) => item.mmsi === mmsi)
      .map((item) => item.time);
  }
}

/**
 * Migration 0004 on a database of version 0.1.0 (migrations 0001–0003, the
 * kit 0.2 outbox) that still holds rows, then the kit's per-key relay with
 * the processor's options.
 */
describe('outbox: 0004 upgrade of a populated kit 0.2 table and per-vessel relaying', () => {
  let pool: Pool;
  let databaseUrl: string;
  let oldMigrations: string;

  async function enqueue(mmsi: number, second: number): Promise<string> {
    const current = position(mmsi, second);
    return enqueueEvent(
      pool,
      EVENT_TYPES.AIS_POSITION_RECORDED,
      toPositionRecorded(current, second === 0 ? null : position(mmsi, 0)),
      { id: positionEventId(mmsi, current.time) },
    );
  }

  function relay(publisher: RecordingPublisher): OutboxRelay {
    const config = createTestConfig(processorConfigSchema, {
      DATABASE_URL: databaseUrl,
      NATS_URL: testInfra('nats').nats.url,
      REDIS_URL: testInfra('redis').redis.url,
      OUTBOX_RETRY_BASE_MS: '50',
      OUTBOX_RETRY_MAX_MS: '200',
    });
    return new OutboxRelay(
      pool,
      // The relay only calls publishEvent, which RecordingPublisher implements.
      publisher as unknown as EventPublisher,
      { ...outboxModuleOptions(config), autoStart: false },
      null,
    );
  }

  beforeAll(async () => {
    databaseUrl = await resetProcessorSchema();
    pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${SERVICE.processor.schema},public`,
    });
    oldMigrations = await mkdtemp(join(tmpdir(), 'ais-pipeline-migrations-'));
    for (const file of [
      '0001_init.sql',
      '0002_positions_1m.sql',
      '0003_outbox.sql',
    ])
      await copyFile(
        join(SERVICE.processor.migrationsDir, file),
        join(oldMigrations, file),
      );
    await runMigrations({
      pool,
      schema: SERVICE.processor.schema,
      dir: oldMigrations,
    });
  });

  afterAll(async () => {
    await pool.end();
    await rm(oldMigrations, { recursive: true, force: true });
  });

  it('keeps the pending rows in their 0.2 order, drops the published ones and relays per key; a failing vessel backs off alone', async () => {
    // Rows a 0.1.0 processor left: two published, four pending.
    const published = [await enqueue(HEALTHY, 0), await enqueue(FAILING, 0)];
    await pool.query(
      'UPDATE outbox SET published_at = now() WHERE id = ANY($1::uuid[])',
      [published],
    );
    const pending = [
      await enqueue(FAILING, 10),
      await enqueue(HEALTHY, 10),
      await enqueue(FAILING, 20),
      await enqueue(HEALTHY, 20),
    ];
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'ais' AND table_name = 'outbox' AND column_name IN ('seq', 'next_attempt_at')`,
    );
    expect(columns.rows).toEqual([]);

    // The boot of 0.2.0 applies 0004 (and 0005).
    const report = await runMigrations({
      pool,
      schema: SERVICE.processor.schema,
      dir: SERVICE.processor.migrationsDir,
    });
    expect(report.applied.map((migration) => migration.name)).toEqual([
      'outbox_per_key',
      'traffic_minutes',
    ]);
    const rows = await pool.query<{ id: string; seq: string }>(
      'SELECT id, seq FROM outbox ORDER BY seq',
    );
    expect(rows.rows.map((row) => row.id)).toEqual(pending);
    expect(rows.rows.map((row) => Number(row.seq))).toEqual([1, 2, 3, 4]);
    // New rows continue the numbering.
    await enqueue(HEALTHY, 30);
    const next = await pool.query<{ seq: string }>(
      'SELECT seq FROM outbox WHERE id = $1',
      [positionEventId(HEALTHY, position(HEALTHY, 30).time)],
    );
    expect(Number(next.rows[0]?.seq)).toBe(5);

    const publisher = new RecordingPublisher();
    publisher.failing.add(FAILING);
    publisher.failuresLeft = 1;
    const outbox = relay(publisher);
    expect(await outbox.mode()).toBe('per-key');

    // The failing vessel's first row fails: only that vessel waits.
    expect(await outbox.relayOnce()).toMatchObject({
      mode: 'per-key',
      published: 3,
      failed: true,
      retrying: 1,
    });
    const time = (second: number) => new Date(T0 + second * 1000).toISOString();
    expect(publisher.timesOf(HEALTHY)).toEqual([time(10), time(20), time(30)]);
    expect(publisher.timesOf(FAILING)).toEqual([]);
    const failed = await pool.query<{
      attempts: number;
      last_error: string;
      scheduled: boolean;
    }>(
      `SELECT attempts, last_error, next_attempt_at IS NOT NULL AS scheduled
         FROM outbox WHERE id = $1`,
      [pending[0]],
    );
    expect(failed.rows).toEqual([
      {
        attempts: 1,
        last_error: 'maximum messages per subject exceeded',
        scheduled: true,
      },
    ]);

    // After its backoff (OUTBOX_RETRY_*: 50–200 ms) the vessel resumes in order.
    await sleep(250);
    expect(await outbox.relayOnce()).toMatchObject({ published: 2 });
    expect(publisher.timesOf(FAILING)).toEqual([time(10), time(20)]);
  });
});
