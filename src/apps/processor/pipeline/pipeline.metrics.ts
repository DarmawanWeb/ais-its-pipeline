import type { AisSource } from '@darmawanweb/ais-its-contracts/domain';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { Injectable } from '@nestjs/common';

/** What the processor did with a raw report (`aisits_ais_messages_total{outcome}`). */
export type PipelineOutcome =
  | 'recorded'
  | 'stationary'
  | 'duplicate'
  | 'conflict'
  | 'out_of_order'
  | 'rejected'
  | 'failed';

/** Where a vessel's last position came from when it was not in memory. */
export type StateLoad = 'valkey' | 'database' | 'none';

/** Result of revalidating a cached last position against Valkey. */
export type StateRevalidation = 'current' | 'stale';

/** A failed Valkey operation on the last positions. */
export type StateOperation = 'load' | 'revalidate' | 'save';

function instruments(metrics: MetricsService) {
  return {
    messages: metrics.counter({
      name: 'ais_messages_total',
      help: 'Raw AIS reports handled by the processor, by feed and outcome',
      labelNames: ['source', 'outcome'],
    }),
    lag: metrics.histogram({
      name: 'ais_ingest_lag_seconds',
      help: 'Delay between the position time and its recording (rows and event committed)',
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 900, 3600],
    }),
    batchRows: metrics.histogram({
      name: 'ais_write_batch_rows',
      help: 'Rows per positions write transaction',
      buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
    }),
    batchDuration: metrics.histogram({
      name: 'ais_write_batch_duration_seconds',
      help: 'Duration of a positions write transaction',
    }),
    stateLoads: metrics.counter({
      name: 'ais_state_loads_total',
      help: 'Last-position lookups that missed the in-memory cache, by origin',
      labelNames: ['origin'],
    }),
    stateRevalidations: metrics.counter({
      name: 'ais_state_revalidations_total',
      help: 'In-memory last positions checked against Valkey before use, by result (stale = another replica recorded the vessel)',
      labelNames: ['result'],
    }),
    staleDecisions: metrics.counter({
      name: 'ais_state_stale_decisions_total',
      help: 'Reports decided on a stale vessel state and corrected by the write transaction (stored latest position authoritative)',
    }),
    stateErrors: metrics.counter({
      name: 'ais_state_errors_total',
      help: 'Failed Valkey operations on the last positions (the processor falls back to the database)',
      labelNames: ['operation'],
    }),
  };
}

/** Domain metrics of the processor (spec §10, §13.2). */
@Injectable()
export class PipelineMetrics {
  readonly instruments: ReturnType<typeof instruments>;

  constructor(metrics: MetricsService) {
    this.instruments = instruments(metrics);
  }

  outcome(source: AisSource, outcome: PipelineOutcome): void {
    this.instruments.messages.inc({ source, outcome });
  }

  /** Observes the lag of a recorded position [s]. */
  recorded(positionTime: Date, now: number = Date.now()): void {
    this.instruments.lag.observe(
      Math.max(0, (now - positionTime.getTime()) / 1000),
    );
  }

  stateLoaded(origin: StateLoad): void {
    this.instruments.stateLoads.inc({ origin });
  }

  stateRevalidated(result: StateRevalidation): void {
    this.instruments.stateRevalidations.inc({ result });
  }

  staleDecision(): void {
    this.instruments.staleDecisions.inc();
  }

  stateError(operation: StateOperation): void {
    this.instruments.stateErrors.inc({ operation });
  }
}
