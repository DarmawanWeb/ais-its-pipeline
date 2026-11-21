import type { AisRawReceivedV1 } from '@darmawanweb/ais-its-contracts/events';
import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { RetryableError } from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';

import { classifyMovement } from '../../../shared/domain/movement.js';
import { predictNavStatus } from '../../../shared/domain/navstatus.js';
import { CoastlineService } from '../coastline/coastline.service.js';
import type { ProcessorConfig } from '../config.js';
import { LastPositionStore } from './last-position.store.js';
import { PipelineMetrics, type PipelineOutcome } from './pipeline.metrics.js';
import { PositionEventsPublisher } from './position-events.publisher.js';
import { PositionWriter } from './position-writer.js';
import type { RecordedPosition } from './recorded-position.js';
import {
  type VesselEntry,
  VesselStateResetError,
  VesselTracker,
} from './vessel-tracker.js';

/** What a decision asks the handler to wait for. */
type Step =
  | {
      readonly outcome: 'stationary' | 'duplicate' | 'conflict';
      readonly wait?: Promise<void>;
    }
  | {
      readonly outcome: 'out_of_order' | 'recorded';
      readonly wait: Promise<void>;
    };

/**
 * The processor's handling of one raw report (spec §13.2, §15.1):
 *
 * 1. the vessel's last position comes from memory, Valkey or the database;
 * 2. the report is classified against it ({@link classifyMovement}): a newer
 *    report that moved < `AIS_DEDUP_MIN_DISTANCE_M` is skipped, a repeated
 *    one waits for (or found) the original, an older one is stored only;
 * 3. recorded reports get the coast distance and the predicted navstatus
 *    (legacy parity, previous = the latest position), are written in batches
 *    (`positions` + `vessel_latest`), then published as
 *    `ais.position.recorded.v1` with `previous`, then saved as the vessel's
 *    last position — in that order, per vessel in report order.
 *
 * The message is acknowledged only when its rows are committed (and, for a
 * new latest position, published), so a crash at any point redelivers it;
 * every step is idempotent (primary keys, deterministic event ids).
 */
@Injectable()
export class PositionPipelineService {
  private readonly tracker: VesselTracker;

  constructor(
    private readonly store: LastPositionStore,
    private readonly writer: PositionWriter,
    private readonly events: PositionEventsPublisher,
    private readonly coastline: CoastlineService,
    private readonly metrics: PipelineMetrics,
    @InjectConfig() private readonly config: ProcessorConfig,
  ) {
    this.tracker = new VesselTracker(
      (mmsi) => this.store.load(mmsi),
      config.AIS_STATE_CACHE_SIZE,
    );
  }

  /** Vessels whose state is in memory. */
  trackedVessels(): number {
    return this.tracker.size;
  }

  /**
   * Handles one report; resolves when it is durably handled.
   *
   * @throws {RetryableError} on any failure (the message is redelivered)
   */
  async process(report: AisRawReceivedV1): Promise<PipelineOutcome> {
    const entry = this.tracker.acquire(report.mmsi);
    try {
      const step = await this.tracker.decide(entry, (vessel) =>
        this.decide(vessel, report),
      );
      await step.wait;
      this.metrics.outcome(report.source, step.outcome);
      return step.outcome;
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
  private decide(entry: VesselEntry, report: AisRawReceivedV1): Step {
    const time = new Date(report.positionTime);
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
        return { outcome: 'stationary' };
      case 'same_time':
        if (!movement.samePosition) return { outcome: 'conflict' };
        // A redelivery or the same report from another feed: done once the original is.
        return entry.latestCommit === null
          ? { outcome: 'duplicate' }
          : { outcome: 'duplicate', wait: entry.latestCommit };
      case 'out_of_order':
        // Stored for the track, never the latest state, no event (no backwards `previous`).
        return {
          outcome: 'out_of_order',
          wait: this.writer.write({
            position: this.enrich(report, time, null),
            latest: false,
          }),
        };
      case 'first':
      case 'advance': {
        const position = this.enrich(report, time, latest);
        entry.state = position;
        const written = this.writer.write({ position, latest: true });
        const commit = this.tracker.chainCommit(entry, written, async () => {
          await this.events.publish(position, latest);
          await this.store.save(position);
          this.metrics.recorded(position.time);
        });
        entry.latestCommit = commit;
        commit.then(
          () => {
            if (entry.latestCommit === commit) entry.latestCommit = null;
          },
          () => undefined,
        );
        return { outcome: 'recorded', wait: commit };
      }
    }
  }

  /**
   * The recorded form of a report: coast distance (`geo.coast_distance`) and
   * predicted navstatus (`navstatus.prediction`, previous = the vessel's
   * latest position, the report itself for a first or out-of-order report).
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
