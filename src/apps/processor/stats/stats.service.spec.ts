import { describe, expect, it, vi } from 'vitest';

import type { StatsRepository, TrafficBucketRow } from './stats.repository.js';
import {
  bucketStart,
  STATS_SERIES_MAX_RANGE_MS,
  StatsService,
  trafficPoints,
} from './stats.service.js';

const T0 = Date.UTC(2026, 10, 22, 10, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

function row(
  minutes: number,
  source: TrafficBucketRow['source'],
  messages: number,
  activeVessels: number,
  samples = 1,
): TrafficBucketRow {
  return { at: at(minutes), source, samples, messages, activeVessels };
}

describe('bucketStart', () => {
  it('floors to UTC-aligned buckets', () => {
    const time = new Date(Date.UTC(2026, 10, 22, 10, 37, 42, 500));
    expect(bucketStart(time, '1m')).toEqual(
      new Date(Date.UTC(2026, 10, 22, 10, 37)),
    );
    expect(bucketStart(time, '5m')).toEqual(
      new Date(Date.UTC(2026, 10, 22, 10, 35)),
    );
    expect(bucketStart(time, '1h')).toEqual(
      new Date(Date.UTC(2026, 10, 22, 10, 0)),
    );
  });
});

describe('trafficPoints', () => {
  it('adds the feeds of each bucket up, in time order, with zeros for feeds without a row', () => {
    const points = trafficPoints([
      row(5, 'pusher', 7, 3, 5),
      row(0, 'primary', 100, 40, 4),
      row(0, 'batam', 20, 10, 4),
    ]);
    expect(points).toEqual([
      {
        at: at(0),
        samples: 4,
        messages: 120,
        activeVessels: 50,
        bySource: {
          primary: { messages: 100, activeVessels: 40 },
          batam: { messages: 20, activeVessels: 10 },
          pusher: { messages: 0, activeVessels: 0 },
        },
      },
      {
        at: at(5),
        samples: 5,
        messages: 7,
        activeVessels: 3,
        bySource: {
          primary: { messages: 0, activeVessels: 0 },
          batam: { messages: 0, activeVessels: 0 },
          pusher: { messages: 7, activeVessels: 3 },
        },
      },
    ]);
  });

  it('is empty without samples', () => {
    expect(trafficPoints([])).toEqual([]);
  });
});

describe('StatsService.series', () => {
  it('floors from to the bucket and reads the buckets of the range', async () => {
    const repository = {
      trafficBuckets: vi.fn(() => Promise.resolve([row(0, 'primary', 3, 2)])),
    };
    const stats = new StatsService(repository as unknown as StatsRepository);
    const series = await stats.series({
      from: new Date(T0 + 3 * 60_000 + 1234),
      to: at(60),
      bucket: '5m',
    });
    expect(repository.trafficBuckets).toHaveBeenCalledWith(
      '5 minutes',
      at(0),
      at(60),
    );
    expect(series).toMatchObject({
      from: at(0),
      to: at(60),
      bucket: '5m',
      bucketMinutes: 5,
      activeWindowMinutes: 10,
    });
    expect(series.points).toHaveLength(1);
  });

  it('bounds every bucket size to at most 2 160 points', () => {
    expect(STATS_SERIES_MAX_RANGE_MS['1m'] / 60_000).toBe(1440);
    expect(STATS_SERIES_MAX_RANGE_MS['5m'] / 300_000).toBe(2016);
    expect(STATS_SERIES_MAX_RANGE_MS['1h'] / 3_600_000).toBe(2160);
  });
});
