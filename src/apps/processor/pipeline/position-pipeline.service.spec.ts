import type { AisRawReceivedV1 } from '@darmawanweb/ais-its-contracts/events';
import { APP_CONFIG } from '@darmawanweb/ais-its-nest';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CoastlineService } from '../coastline/coastline.service.js';
import { LastPositionStore } from './last-position.store.js';
import { PipelineMetrics } from './pipeline.metrics.js';
import { PositionEventsPublisher } from './position-events.publisher.js';
import { PositionPipelineService } from './position-pipeline.service.js';
import { PositionWriter } from './position-writer.js';
import type { PositionRow } from './positions-write.repository.js';
import type { RecordedPosition } from './recorded-position.js';

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

/** In-memory fakes of the pipeline's I/O (Valkey/database, writer, NATS, coastline). */
function fakes() {
  const saved = new Map<number, RecordedPosition>();
  const rows: PositionRow[] = [];
  const published: {
    position: RecordedPosition;
    previous: RecordedPosition | null;
  }[] = [];
  return {
    saved,
    rows,
    published,
    store: {
      load: vi.fn((mmsi: number) => Promise.resolve(saved.get(mmsi) ?? null)),
      save: vi.fn((position: RecordedPosition) => {
        saved.set(position.mmsi, position);
        return Promise.resolve();
      }),
    },
    writer: {
      write: vi.fn((row: PositionRow) => {
        rows.push(row);
        return Promise.resolve();
      }),
    },
    events: {
      publish: vi.fn(
        (position: RecordedPosition, previous: RecordedPosition | null) => {
          published.push({ position, previous });
          return Promise.resolve();
        },
      ),
    },
    coastline: { distanceM: vi.fn(() => 5000) },
  };
}

describe('PositionPipelineService', () => {
  let io: ReturnType<typeof fakes>;
  let pipeline: PositionPipelineService;

  beforeEach(async () => {
    io = fakes();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PositionPipelineService,
        PipelineMetrics,
        MetricsService,
        { provide: LastPositionStore, useValue: io.store },
        { provide: PositionWriter, useValue: io.writer },
        { provide: PositionEventsPublisher, useValue: io.events },
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
    pipeline = moduleRef.get(PositionPipelineService);
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
    expect(
      io.published.map(({ previous }) => previous?.time.getTime() ?? null),
    ).toEqual([null, T0]);
    expect(io.saved.get(MMSI)?.time.getTime()).toBe(T0 + 30_000);
    expect(io.published[0]?.position).toMatchObject({
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
    expect(io.published).toHaveLength(2);
  });

  it('stores an out-of-order report without event, Valkey update or previous link', async () => {
    await pipeline.process(report(0, -7.2));
    await pipeline.process(report(30, -7.2 + STEP));

    expect(await pipeline.process(report(-60, -7.2 - STEP))).toBe(
      'out_of_order',
    );
    expect(io.rows.at(-1)).toMatchObject({ latest: false });
    expect(io.published).toHaveLength(2);
    expect(io.saved.get(MMSI)?.time.getTime()).toBe(T0 + 30_000);

    await pipeline.process(report(90, -7.2 + 2 * STEP));
    expect(io.published.at(-1)?.previous?.time.getTime()).toBe(T0 + 30_000);
  });

  it('answers a redelivery as a duplicate and a different position at the same time as a conflict', async () => {
    await pipeline.process(report(0, -7.2));

    expect(await pipeline.process(report(0, -7.2))).toBe('duplicate');
    expect(await pipeline.process(report(0, -7.3))).toBe('conflict');
    expect(io.rows).toHaveLength(1);
    expect(io.published).toHaveLength(1);
  });

  it('keeps the arrival order of concurrent reports of one vessel', async () => {
    const outcomes = await Promise.all(
      [0, 30, 60].map((offset, i) =>
        pipeline.process(report(offset, -7.2 + i * STEP)),
      ),
    );

    expect(outcomes).toEqual(['recorded', 'recorded', 'recorded']);
    expect(
      io.published.map(({ position, previous }) => [
        position.time.getTime(),
        previous?.time.getTime() ?? null,
      ]),
    ).toEqual([
      [T0, null],
      [T0 + 30_000, T0],
      [T0 + 60_000, T0 + 30_000],
    ]);
    expect(io.store.load).toHaveBeenCalledTimes(1);
  });

  it('retries a report whose publication failed from the last committed state', async () => {
    await pipeline.process(report(0, -7.2));
    io.events.publish.mockRejectedValueOnce(new Error('NATS unavailable'));

    await expect(pipeline.process(report(30, -7.2 + STEP))).rejects.toThrow(
      'NATS unavailable',
    );
    expect(io.saved.get(MMSI)?.time.getTime()).toBe(T0);

    // Redelivery: the state is reloaded (the failed position was never published).
    expect(await pipeline.process(report(30, -7.2 + STEP))).toBe('recorded');
    expect(io.published.at(-1)?.previous?.time.getTime()).toBe(T0);
    expect(io.store.load).toHaveBeenCalledTimes(2);
  });

  it('predicts "at anchor" with the legacy rule and stores no coast distance without geometry', async () => {
    io.coastline.distanceM.mockReturnValue(Number.POSITIVE_INFINITY);

    await pipeline.process(report(0, -7.2, { sog: 0.1, cog: 10, hdg: 12 }));

    expect(io.published[0]?.position).toMatchObject({
      predictedNavstatus: 1,
      coastDistanceM: null,
    });
  });
});
