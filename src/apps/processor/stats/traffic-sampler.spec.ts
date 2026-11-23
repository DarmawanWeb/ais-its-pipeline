import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StatsRepository } from './stats.repository.js';
import {
  MAX_SAMPLE_LATENESS_MS,
  msUntilNextSample,
  msUntilSampleTime,
  SAMPLE_DELAY_MS,
  TrafficSampler,
} from './traffic-sampler.js';

function sampler(sampleMinute: StatsRepository['sampleMinute']) {
  const repository = { sampleMinute: vi.fn(sampleMinute) };
  const metrics = new MetricsService();
  return {
    repository,
    metrics,
    sampler: new TrafficSampler(
      repository as unknown as StatsRepository,
      metrics,
    ),
  };
}

describe('msUntilNextSample', () => {
  it('waits until SAMPLE_DELAY_MS after the next minute boundary', () => {
    const minute = Date.UTC(2026, 10, 22, 10, 0, 0);
    expect(msUntilNextSample(minute)).toBe(60_000 + SAMPLE_DELAY_MS);
    expect(msUntilNextSample(minute + 59_000)).toBe(1000 + SAMPLE_DELAY_MS);
    // Sampling at :05 schedules the next sample a full minute later.
    expect(msUntilNextSample(minute + SAMPLE_DELAY_MS)).toBe(60_000);
  });
});

describe('msUntilSampleTime', () => {
  const minute = Date.UTC(2026, 10, 22, 10, 0, 0);

  it('before SAMPLE_DELAY_MS past the boundary: waits for the on-time sample of the minute that ended', () => {
    expect(msUntilSampleTime(minute)).toBe(SAMPLE_DELAY_MS);
    expect(msUntilSampleTime(minute + 2600)).toBe(SAMPLE_DELAY_MS - 2600);
    expect(msUntilSampleTime(minute + SAMPLE_DELAY_MS - 1)).toBe(1);
  });

  it('samples at once up to MAX_SAMPLE_LATENESS_MS (10 s) after that time', () => {
    expect(MAX_SAMPLE_LATENESS_MS).toBe(10_000);
    expect(msUntilSampleTime(minute + SAMPLE_DELAY_MS)).toBe(0);
    expect(msUntilSampleTime(minute + 9000)).toBe(0);
    expect(
      msUntilSampleTime(minute + SAMPLE_DELAY_MS + MAX_SAMPLE_LATENESS_MS),
    ).toBe(0);
  });

  it('later in the minute: leaves the minute that ended and waits for the next boundary', () => {
    const tooLate = minute + SAMPLE_DELAY_MS + MAX_SAMPLE_LATENESS_MS + 1;
    expect(msUntilSampleTime(tooLate)).toBe(msUntilNextSample(tooLate));
    // A start 44.8 s after the minute ended (the review's scratch boot).
    expect(msUntilSampleTime(minute + 44_800)).toBe(20_200);
    expect(msUntilSampleTime(minute + 59_999)).toBe(1 + SAMPLE_DELAY_MS);
  });
});

describe('TrafficSampler.sample', () => {
  it('samples every feed with the 10-minute active window and counts the outcome', async () => {
    const {
      sampler: traffic,
      repository,
      metrics,
    } = sampler(() => Promise.resolve(true));
    const minute = new Date(Date.UTC(2026, 10, 22, 10, 0));
    expect(await traffic.sample(minute)).toBe('recorded');
    expect(repository.sampleMinute).toHaveBeenCalledWith({
      minute,
      activeWindowMs: 600_000,
      sources: ['primary', 'batam', 'pusher'],
    });
    repository.sampleMinute.mockResolvedValueOnce(false);
    expect(await traffic.sample()).toBe('exists');
    expect(await metrics.render()).toMatch(
      /aisits_ais_stats_samples_total\{outcome="exists"\} 1/,
    );
  });

  it('never throws: a failed sample is counted as failed and warned about once per 10 minutes', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { sampler: traffic, metrics } = sampler(() =>
      Promise.reject(new Error('connection refused')),
    );
    expect(await traffic.sample()).toBe('failed');
    expect(await traffic.sample()).toBe('failed');
    expect(await metrics.render()).toMatch(
      /aisits_ais_stats_samples_total\{outcome="failed"\} 2/,
    );
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('TrafficSampler schedule', () => {
  /** A minute boundary (10:01:00 UTC). */
  const boundary = Date.UTC(2026, 10, 22, 10, 1, 0);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Starts a sampler at `at` and returns the times (offsets from `boundary`) it sampled at. */
  async function start(at: number) {
    vi.setSystemTime(at);
    const sampledAt: number[] = [];
    const started = sampler(() => {
      sampledAt.push(Date.now() - boundary);
      return Promise.resolve(true);
    });
    started.sampler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    return { ...started, sampledAt };
  }

  it('a start up to 10 s after the sample time samples the last minute at once, then 5 s after each minute', async () => {
    const {
      sampler: traffic,
      repository,
      sampledAt,
    } = await start(boundary + SAMPLE_DELAY_MS + MAX_SAMPLE_LATENESS_MS);
    expect(sampledAt).toEqual([15_000]);
    // The last completed minute by the database clock.
    expect(repository.sampleMinute).toHaveBeenCalledWith(
      expect.objectContaining({ minute: undefined }),
    );
    await vi.advanceTimersByTimeAsync(49_999);
    expect(sampledAt).toEqual([15_000]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sampledAt).toEqual([15_000, 65_000, 125_000]);
    await traffic.beforeApplicationShutdown();
  });

  it('a start later in the minute (44.8 s) leaves that minute: the first sample is 5 s after the next one ends', async () => {
    const { sampler: traffic, sampledAt } = await start(boundary + 44_800);
    expect(sampledAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_199);
    expect(sampledAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sampledAt).toEqual([65_000]);
    await traffic.beforeApplicationShutdown();
  });

  it('a start in the first 5 s of a minute waits for the on-time sample (no early row that blocks the other replicas)', async () => {
    const { sampler: traffic, sampledAt } = await start(boundary + 2600);
    expect(sampledAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(2399);
    expect(sampledAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sampledAt).toEqual([SAMPLE_DELAY_MS]);
    await traffic.beforeApplicationShutdown();
  });

  it('a timer firing early waits for the sample time; one firing more than 10 s late (a stalled process) skips that minute', async () => {
    const { sampler: traffic, sampledAt } = await start(
      boundary + SAMPLE_DELAY_MS,
    );
    expect(sampledAt).toEqual([SAMPLE_DELAY_MS]);
    // The wall clock moves 3 ms back: the next timer fires at :04.997.
    vi.setSystemTime(Date.now() - 3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sampledAt).toEqual([SAMPLE_DELAY_MS]);
    await vi.advanceTimersByTimeAsync(3);
    expect(sampledAt).toEqual([SAMPLE_DELAY_MS, 65_000]);
    // The process stalls for 20 s: the next timer fires at :25.
    vi.setSystemTime(Date.now() + 20_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sampledAt).toEqual([SAMPLE_DELAY_MS, 65_000]);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(sampledAt).toEqual([SAMPLE_DELAY_MS, 65_000, 185_000]);
    await traffic.beforeApplicationShutdown();
  });

  it('stops its timer on shutdown', async () => {
    const { sampler: traffic, sampledAt } = await start(boundary + 44_800);
    await traffic.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(sampledAt).toEqual([]);
  });
});
