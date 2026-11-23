import { AIS_SOURCES } from '@darmawanweb/ais-its-contracts/domain';
import { sanitizeError } from '@darmawanweb/ais-its-nest/db';
import {
  type Counter,
  MetricsService,
} from '@darmawanweb/ais-its-nest/metrics';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import { StatsRepository } from './stats.repository.js';
import { ACTIVE_WINDOW_MS } from './stats.service.js';

/**
 * Delay after a minute ends before it is sampled [ms]: reports of the
 * minute's last seconds are still in their write batch
 * (`PROCESSOR_FLUSH_MS`, 1 s by default).
 */
export const SAMPLE_DELAY_MS = 5000;

/**
 * How much later than `SAMPLE_DELAY_MS` after its end a minute may still be
 * sampled [ms] (a replica starting then): a later sample would count vessels
 * that first reported after the minute ended as active at its end
 * (`vessel_latest` has moved on).
 */
export const MAX_SAMPLE_LATENESS_MS = 10_000;

/** Shortest interval between two warnings about failed samples [ms]. */
const WARNING_INTERVAL_MS = 10 * 60_000;

/** What a sampling attempt did (`aisits_ais_stats_samples_total{outcome}`). */
export type SampleOutcome = 'recorded' | 'exists' | 'failed';

/** Time until `SAMPLE_DELAY_MS` after the next minute boundary of `now` [ms]. */
export function msUntilNextSample(now: number): number {
  return Math.floor(now / 60_000) * 60_000 + 60_000 + SAMPLE_DELAY_MS - now;
}

/**
 * Time from `now` until the last completed minute may be sampled [ms]; `0`:
 * now, from `SAMPLE_DELAY_MS` to `SAMPLE_DELAY_MS + MAX_SAMPLE_LATENESS_MS`
 * after the minute boundary. Earlier (a replica starting, a timer firing a
 * few ms early) it waits for that time: an early sample would miss the
 * reports still in their write batch and, as the first row wins, block the
 * on-time samples of the other replicas. Later (a replica starting late in
 * the minute, a stalled process) it leaves that minute to the other
 * replicas (a gap if none runs) and waits for the next boundary.
 */
export function msUntilSampleTime(now: number): number {
  const sinceBoundary = now - Math.floor(now / 60_000) * 60_000;
  if (sinceBoundary < SAMPLE_DELAY_MS) return SAMPLE_DELAY_MS - sinceBoundary;
  if (sinceBoundary <= SAMPLE_DELAY_MS + MAX_SAMPLE_LATENESS_MS) return 0;
  return msUntilNextSample(now);
}

/**
 * Records the history of `GET /ais/stats` (table `traffic_minutes`, read by
 * `GET /ais/stats/series`): every replica samples the last completed minute
 * by the database clock `SAMPLE_DELAY_MS` after each minute boundary (by its
 * own clock, assumed to agree with the database's within a second or so);
 * the first replica's row wins (`ON CONFLICT DO NOTHING`), so a minute is
 * sampled once while at least one processor runs. At start, and whenever a
 * timer fires off time, it samples only within `MAX_SAMPLE_LATENESS_MS` of
 * that time ({@link msUntilSampleTime}): a row is taken 5–15 s after its
 * minute ended, never earlier, so a replica starting more than 15 s after a
 * minute ended leaves that minute to the others. A failed sample is counted
 * and logged (at most every 10 minutes), never retried: the active vessels
 * of a past minute cannot be recomputed.
 */
@Injectable()
export class TrafficSampler
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(TrafficSampler.name);
  private readonly samples: Counter<'outcome'>;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<SampleOutcome> | null = null;
  private stopped = false;
  private lastWarningAt = 0;

  constructor(
    private readonly repository: StatsRepository,
    metrics: MetricsService,
  ) {
    this.samples = metrics.counter({
      name: 'ais_stats_samples_total',
      help: 'Minutes sampled for GET /ais/stats/series by this instance, by outcome (exists = another replica sampled the minute first)',
      labelNames: ['outcome'],
    });
  }

  onApplicationBootstrap(): void {
    void this.tick();
  }

  /** Stops the timer and waits for a sample in progress (before the pool closes). */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  /**
   * Samples `minute` (start of a minute; default the last completed minute
   * by the database clock); never throws.
   */
  async sample(minute?: Date): Promise<SampleOutcome> {
    let outcome: SampleOutcome;
    try {
      const recorded = await this.repository.sampleMinute({
        minute,
        activeWindowMs: ACTIVE_WINDOW_MS,
        sources: AIS_SOURCES,
      });
      outcome = recorded ? 'recorded' : 'exists';
    } catch (error) {
      outcome = 'failed';
      this.warn(error);
    }
    this.samples.inc({ outcome });
    return outcome;
  }

  /**
   * Samples the last completed minute when it is time for it
   * ({@link msUntilSampleTime}), then schedules the next tick.
   */
  private async tick(): Promise<void> {
    this.timer = null;
    if (this.isStopped()) return;
    const waitMs = msUntilSampleTime(Date.now());
    if (waitMs > 0) {
      this.schedule(waitMs);
      return;
    }
    this.running = this.sample();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
    // Shutdown may have started while the sample ran.
    if (this.isStopped()) return;
    this.schedule(msUntilNextSample(Date.now()));
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref();
  }

  /** Read through a method: shutdown changes it while a sample is awaited. */
  private isStopped(): boolean {
    return this.stopped;
  }

  private warn(error: unknown): void {
    const now = Date.now();
    if (now - this.lastWarningAt < WARNING_INTERVAL_MS) return;
    this.lastWarningAt = now;
    // Database errors without bound values (the kit's error hygiene).
    const err = sanitizeError(error);
    this.logger.warn({
      msg: `Sampling the traffic of the last minute failed (a gap in GET /ais/stats/series): ${err instanceof Error ? err.message : String(err)}`,
      err,
    });
  }
}
