import type { AisRawReceivedV1 } from '@darmawanweb/ais-its-contracts/events';
import { InjectConfig } from '@darmawanweb/ais-its-nest';
import {
  NonRetryableError,
  RetryableError,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';

import { isUuidV7Time } from '../../../shared/domain/event-id.js';
import { classifyMovement } from '../../../shared/domain/movement.js';
import { predictNavStatus } from '../../../shared/domain/navstatus.js';
import { CoastlineService } from '../coastline/coastline.service.js';
import type { ProcessorConfig } from '../config.js';
import { LastPositionStore } from './last-position.store.js';
import { PipelineMetrics, type PipelineOutcome } from './pipeline.metrics.js';
import { PositionWriter } from './position-writer.js';
import type { RecordedPosition } from './recorded-position.js';
import type { PositionRow } from './resolve-batch.js';
import {
  type VesselEntry,
  VesselStateResetError,
  VesselTracker,
} from './vessel-tracker.js';

/**
 * A decision, wrapped so the per-vessel decision queue does not wait for
 * the write it started.
 */
interface Step {
  /** Resolves with the final outcome once the report is durably handled. */
  readonly settled: Promise<PipelineOutcome>;
}

const done = (outcome: PipelineOutcome): Step => ({
  settled: Promise.resolve(outcome),
});

/**
 * The processor's handling of one raw report (spec §13.2, §15.1):
 *
 * 1. the vessel's last position comes from memory (revalidated against
 *    Valkey), Valkey or the database;
 * 2. the report is classified against it ({@link classifyMovement}): a newer
 *    report that moved < `AIS_DEDUP_MIN_DISTANCE_M` is skipped, a repeated
 *    one waits for (or found) the original, an older one is stored only;
 * 3. recorded reports get the coast distance and the predicted navstatus
 *    (legacy parity, previous = the latest position) and are written in
 *    batches: `positions`, `vessel_latest` and the `ais.position.recorded.v1`
 *    event (transactional outbox, published by the kit's relay) commit
 *    together, resolved against the stored latest position under lock;
 * 4. the vessel's latest position is saved in Valkey (monotonic).
 *
 * The message is acknowledged once its rows and event are committed, so a
 * crash at any point redelivers it; every step is idempotent (primary keys,
 * the stored latest position, deterministic event ids).
 */
@Injectable()
export class PositionPipelineService {
  private readonly tracker: VesselTracker;

  constructor(
    private readonly store: LastPositionStore,
    private readonly writer: PositionWriter,
    private readonly coastline: CoastlineService,
    private readonly metrics: PipelineMetrics,
    @InjectConfig() private readonly config: ProcessorConfig,
  ) {
    this.tracker = new VesselTracker(store, config.AIS_STATE_CACHE_SIZE);
  }

  /** Vessels whose state is in memory. */
  trackedVessels(): number {
    return this.tracker.size;
  }

  /**
   * Handles one report; resolves when it is durably handled.
   *
   * @throws {NonRetryableError} for a position time no event id can carry (before 1970)
   * @throws {RetryableError} on any other failure (the message is redelivered)
   */
  async process(report: AisRawReceivedV1): Promise<PipelineOutcome> {
    const time = new Date(report.positionTime);
    // The ingestor rejects implausible times; never let one reach a batch.
    if (!isUuidV7Time(time.getTime())) {
      this.metrics.outcome(report.source, 'rejected');
      throw new NonRetryableError(
        `Position time ${report.positionTime} of vessel ${report.mmsi} cannot be recorded`,
      );
    }
    const entry = this.tracker.acquire(report.mmsi);
    try {
      const step = await this.tracker.decide(entry, (vessel) =>
        this.decide(vessel, report, time),
      );
      const outcome = await step.settled;
      this.metrics.outcome(report.source, outcome);
      return outcome;
    } catch (error) {
      this.metrics.outcome(report.source, 'failed');
      if (error instanceof VesselStateResetError)
        throw new RetryableError(error.message, { cause: error });
      throw error;
    } finally {
      this.tracker.release(entry);
    }
  }

  /** Classifies the report against the vessel's latest position (synchronous, in report order). */
  private decide(
    entry: VesselEntry,
    report: AisRawReceivedV1,
    time: Date,
  ): Step {
    const latest = entry.state;
    const movement = classifyMovement(
      latest === null
        ? null
        : { timeMs: latest.time.getTime(), lat: latest.lat, lon: latest.lon },
      { timeMs: time.getTime(), lat: report.lat, lon: report.lon },
      this.config.AIS_DEDUP_MIN_DISTANCE_M,
    );
    switch (movement.kind) {
      case 'stationary':
        return done('stationary');
      case 'same_time': {
        if (!movement.samePosition) return done('conflict');
        // A redelivery or the same report from another feed: done once the
        // original is (a committed original has its event in the outbox).
        const original = entry.latestCommit ?? Promise.resolve();
        return { settled: original.then(() => 'duplicate' as const) };
      }
      case 'out_of_order':
        // Stored for the track, never the latest state, no event (no backwards `previous`).
        return {
          settled: this.write(entry, {
            position: this.enrich(report, time, null),
            latest: false,
            assumedPrevious: null,
          }),
        };
      case 'first':
      case 'advance': {
        const position = this.enrich(report, time, latest);
        entry.state = position;
        const settled = this.write(entry, {
          position,
          latest: true,
          assumedPrevious: latest,
        });
        const commit = settled.then(() => undefined);
        entry.latestCommit = commit;
        commit.then(
          () => {
            if (entry.latestCommit === commit) entry.latestCommit = null;
          },
          () => undefined,
        );
        return { settled };
      }
    }
  }

  /**
   * Writes a row and, once its batch committed, refreshes the vessel's
   * Valkey state; a stale decision detaches the in-memory state, a failed
   * latest-position write discards it (later reports are retried).
   */
  private write(
    entry: VesselEntry,
    row: PositionRow,
  ): Promise<PipelineOutcome> {
    const settled = this.writer.write(row).then(
      async (result): Promise<PipelineOutcome> => {
        if (result.stale) {
          this.metrics.staleDecision();
          this.tracker.invalidate(entry);
        }
        if (result.latest !== null) await this.store.save(result.latest);
        if (result.outcome !== 'recorded') return 'out_of_order';
        this.metrics.recorded(row.position.time);
        return 'recorded';
      },
      (error: unknown) => {
        if (row.latest) this.tracker.fail(entry);
        throw error;
      },
    );
    this.tracker.track(entry, settled);
    return settled;
  }

  /**
   * The recorded form of a report: coast distance (`geo.coast_distance`) and
   * predicted navstatus (`navstatus.prediction`, previous = the vessel's
   * latest position, the report itself for a first or out-of-order report;
   * the write resolves it again against the stored latest position).
   */
  private enrich(
    report: AisRawReceivedV1,
    time: Date,
    latest: RecordedPosition | null,
  ): RecordedPosition {
    const coastDistanceM = this.coastline.distanceM(report.lat, report.lon);
    return {
      mmsi: report.mmsi,
      time,
      source: report.source,
      lat: report.lat,
      lon: report.lon,
      sog: report.sog,
      cog: report.cog,
      hdg: report.hdg,
      navstatus: report.navstatus,
      predictedNavstatus: predictNavStatus(report, latest, coastDistanceM),
      coastDistanceM: Number.isFinite(coastDistanceM) ? coastDistanceM : null,
    };
  }
}
