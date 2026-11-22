import type { AisRawReceivedV1 } from '@darmawanweb/ais-its-contracts/events';
import { APP_CONFIG } from '@darmawanweb/ais-its-nest';
import { NonRetryableError } from '@darmawanweb/ais-its-nest/nats';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CoastlineService } from '../coastline/coastline.service.js';
import { LastPositionStore } from './last-position.store.js';
import { PipelineMetrics } from './pipeline.metrics.js';
import { PositionPipelineService } from './position-pipeline.service.js';
import { PositionWriter } from './position-writer.js';
import type { RecordedPosition } from './recorded-position.js';
import {
  type PositionRecord,
  type PositionRow,
  resolveBatch,
} from './resolve-batch.js';

const MMSI = 525005223;
const T0 = Date.UTC(2026, 10, 21, 10, 0, 0);
/** ≈ 111 m of latitude. */
const STEP = 0.001;

function report(
  offsetS: number,
  lat: number,
  overrides: Partial<AisRawReceivedV1> = {},
): AisRawReceivedV1 {
  return {
    source: 'primary',
    receivedAt: new Date(T0 + offsetS * 1000 + 500).toISOString(),
    positionTime: new Date(T0 + offsetS * 1000).toISOString(),
    mmsi: MMSI,
    navstatus: 0,
    lat,
    lon: 112.7,
    sog: 8,
    cog: 0,
    hdg: 2,
    aisType: 1,
    receiverPort: null,
    ...overrides,
  };
}

/**
 * In-memory fakes of the pipeline's I/O: Valkey (`saved`), the database
 * (`stored` latest positions, `rows`, outbox `events` — each write is one
 * batch resolved with the real {@link resolveBatch}) and the coastline.
 */
function fakes() {
  const saved = new Map<number, RecordedPosition>();
  const stored = new Map<number, RecordedPosition>();
  const rows: PositionRow[] = [];
  const events: PositionRecord[] = [];
  const database = {
    write: (row: PositionRow) => {
      rows.push(row);
      const resolution = resolveBatch([row], stored);
      for (const latest of resolution.latest) stored.set(latest.mmsi, latest);
      events.push(...resolution.events);
      const [result] = resolution.results;
      if (result === undefined) throw new Error('no resolution');
      return Promise.resolve(result);
    },
  };
  return {
    saved,
    stored,
    rows,
    events,
    store: {
      load: vi.fn((mmsi: number) =>
        Promise.resolve(saved.get(mmsi) ?? stored.get(mmsi) ?? null),
      ),
      isCurrent: vi.fn((cached: RecordedPosition) =>
        Promise.resolve(
          (saved.get(cached.mmsi)?.time.getTime() ?? -Infinity) <=
            cached.time.getTime(),
        ),
      ),
      save: vi.fn((position: RecordedPosition) => {
        const current = saved.get(position.mmsi);
        if (current === undefined || current.time < position.time)
          saved.set(position.mmsi, position);
        return Promise.resolve();
      }),
    },
    writer: { write: vi.fn(database.write) },
    coastline: { distanceM: vi.fn(() => 5000) },
  };
}

type Fakes = ReturnType<typeof fakes>;

async function createPipeline(io: Fakes): Promise<PositionPipelineService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      PositionPipelineService,
      PipelineMetrics,
      MetricsService,
      { provide: LastPositionStore, useValue: io.store },
      { provide: PositionWriter, useValue: io.writer },
      { provide: CoastlineService, useValue: io.coastline },
      {
        provide: APP_CONFIG,
        useValue: {
          AIS_DEDUP_MIN_DISTANCE_M: 0.1,
          AIS_STATE_CACHE_SIZE: 100,
        },
      },
    ],
  }).compile();
  return moduleRef.get(PositionPipelineService);
}

const links = (events: readonly PositionRecord[]) =>
  events.map(({ position, previous }) => [
    position.time.getTime(),
    previous?.time.getTime() ?? null,
  ]);

describe('PositionPipelineService', () => {
  let io: Fakes;
  let pipeline: PositionPipelineService;

  beforeEach(async () => {
    io = fakes();
    pipeline = await createPipeline(io);
  });

  it('records a first report (previous null) and an advancing one linked to it', async () => {
    expect(await pipeline.process(report(0, -7.2))).toBe('recorded');
    expect(await pipeline.process(report(30, -7.2 + STEP))).toBe('recorded');

    expect(
      io.rows.map((row) => [row.position.time.getTime(), row.latest]),
    ).toEqual([
      [T0, true],
      [T0 + 30_000, true],
    ]);
    expect(links(io.events)).toEqual([
      [T0, null],
      [T0 + 30_000, T0],
    ]);
    expect(io.saved.get(MMSI)?.time.getTime()).toBe(T0 + 30_000);
    expect(io.events[0]?.position).toMatchObject({
      coastDistanceM: 5000,
      predictedNavstatus: 0,
    });
  });

  it('skips a newer report that moved less than the threshold from the LATEST position', async () => {
    await pipeline.process(report(0, -7.2));
    await pipeline.process(report(30, -7.2 + STEP));

    // 0.05 m from the latest position (but ≈ 111 m from the first one).
    expect(await pipeline.process(report(60, -7.2 + STEP + 0.00000045))).toBe(
      'stationary',
    );
    expect(io.rows).toHaveLength(2);
    expect(io.events).toHaveLength(2);
  });

  it('stores an out-of-order report without event, Valkey update or previous link', async () => {
    await pipeline.process(report(0, -7.2));
    await pipeline.process(report(30, -7.2 + STEP));

    expect(await pipeline.process(report(-60, -7.2 - STEP))).toBe(
      'out_of_order',
    );
    expect(io.rows.at(-1)).toMatchObject({ latest: false });
    expect(io.events).toHaveLength(2);
    expect(io.saved.get(MMSI)?.time.getTime()).toBe(T0 + 30_000);

    await pipeline.process(report(90, -7.2 + 2 * STEP));
    expect(io.events.at(-1)?.previous?.time.getTime()).toBe(T0 + 30_000);
  });

  it('answers a redelivery as a duplicate and a different position at the same time as a conflict', async () => {
    await pipeline.process(report(0, -7.2));

    expect(await pipeline.process(report(0, -7.2))).toBe('duplicate');
    expect(await pipeline.process(report(0, -7.3))).toBe('conflict');
    expect(io.rows).toHaveLength(1);
    expect(io.events).toHaveLength(1);
  });

  it('keeps the arrival order of concurrent reports of one vessel', async () => {
    const outcomes = await Promise.all(
      [0, 30, 60].map((offset, i) =>
        pipeline.process(report(offset, -7.2 + i * STEP)),
      ),
    );

    expect(outcomes).toEqual(['recorded', 'recorded', 'recorded']);
    expect(links(io.events)).toEqual([
      [T0, null],
      [T0 + 30_000, T0],
      [T0 + 60_000, T0 + 30_000],
    ]);
    expect(io.store.load).toHaveBeenCalledTimes(1);
  });

  it('retries a report whose write failed from the last committed state', async () => {
    await pipeline.process(report(0, -7.2));
    io.writer.write.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(pipeline.process(report(30, -7.2 + STEP))).rejects.toThrow(
      'database unavailable',
    );
    expect(io.saved.get(MMSI)?.time.getTime()).toBe(T0);

    // Redelivery: the state is reloaded (the failed position was never stored).
    expect(await pipeline.process(report(30, -7.2 + STEP))).toBe('recorded');
    expect(links(io.events).at(-1)).toEqual([T0 + 30_000, T0]);
    expect(io.store.load).toHaveBeenCalledTimes(2);
  });

  it('never loses the event of a committed position: a redelivery after a crash finds it committed (no Valkey state)', async () => {
    // First position of a new vessel: committed (rows + outbox event), then
    // the process died before saving Valkey and acknowledging.
    io.store.save.mockImplementationOnce(() =>
      Promise.reject(new Error('crash')),
    );
    await expect(pipeline.process(report(0, -7.2))).rejects.toThrow('crash');
    expect(io.saved.has(MMSI)).toBe(false);

    const restarted = await createPipeline(io);
    expect(await restarted.process(report(0, -7.2))).toBe('duplicate');
    expect(links(io.events)).toEqual([[T0, null]]);
  });

  it('reloads a cached state that another replica superseded: an older report is out of order, the next links to the replica position', async () => {
    const replica = await createPipeline(io);
    await pipeline.process(report(0, -7.2));
    await replica.process(report(30, -7.2 + STEP));

    expect(await pipeline.process(report(20, -7.2 + STEP / 2))).toBe(
      'out_of_order',
    );
    expect(await pipeline.process(report(60, -7.2 + 2 * STEP))).toBe(
      'recorded',
    );

    expect(links(io.events)).toEqual([
      [T0, null],
      [T0 + 30_000, T0],
      [T0 + 60_000, T0 + 30_000],
    ]);
    expect(io.saved.get(MMSI)?.time.getTime()).toBe(T0 + 60_000);
    expect(io.stored.get(MMSI)?.time.getTime()).toBe(T0 + 60_000);
  });

  it('corrects a decision on a stale state in the write: the stored latest position wins and Valkey is repaired', async () => {
    const replica = await createPipeline(io);
    await pipeline.process(report(0, -7.2));
    await replica.process(report(30, -7.2 + STEP));
    // Valkey lost the replica's save: revalidation cannot see the newer position.
    io.saved.delete(MMSI);

    expect(await pipeline.process(report(20, -7.2 + STEP / 2))).toBe(
      'out_of_order',
    );
    expect(io.rows.at(-1)).toMatchObject({ latest: true });
    expect(links(io.events)).toEqual([
      [T0, null],
      [T0 + 30_000, T0],
    ]);
    expect(io.stored.get(MMSI)?.time.getTime()).toBe(T0 + 30_000);
    expect(io.saved.get(MMSI)?.time.getTime()).toBe(T0 + 30_000);

    // The detached state is reloaded: the next report links to the stored latest position.
    expect(await pipeline.process(report(60, -7.2 + 2 * STEP))).toBe(
      'recorded',
    );
    expect(links(io.events).at(-1)).toEqual([T0 + 60_000, T0 + 30_000]);
  });

  it('predicts "at anchor" with the legacy rule and stores no coast distance without geometry', async () => {
    io.coastline.distanceM.mockReturnValue(Number.POSITIVE_INFINITY);

    await pipeline.process(report(0, -7.2, { sog: 0.1, cog: 10, hdg: 12 }));

    expect(io.events[0]?.position).toMatchObject({
      predictedNavstatus: 1,
      coastDistanceM: null,
    });
  });

  it('refuses a position time before 1970 (no event id) without writing it', async () => {
    await expect(
      pipeline.process(
        report(0, -7.2, { positionTime: '1960-06-01T00:00:00.000Z' }),
      ),
    ).rejects.toBeInstanceOf(NonRetryableError);
    expect(io.writer.write).not.toHaveBeenCalled();
  });
});
