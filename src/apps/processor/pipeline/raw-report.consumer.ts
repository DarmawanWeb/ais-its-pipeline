import {
  type ConsumerEnvelope,
  DEFAULT_PINNED_TTL_MS,
  EventHandler,
  type ExclusiveConsumerEvent,
  type ExclusiveConsumerListener,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable, Logger } from '@nestjs/common';

import { PositionPipelineService } from './position-pipeline.service.js';

/** Durable consumer of the processor on AIS_RAW (spec §7.3). */
export const RAW_REPORT_CONSUMER = 'ais-processor';

/**
 * How long the server keeps the active instance pinned without a pull [ms]:
 * the kit's default (30 s). The kit pulls every TTL / 3 and heartbeats while
 * idle, so an idle single instance keeps its pin; a crashed active instance
 * is replaced by a standby after up to this long, a gracefully stopped one
 * at once (the kit releases the pin on stop).
 */
export const PROCESSOR_PINNED_TTL_MS = DEFAULT_PINNED_TTL_MS;

/**
 * Durable consumer `ais-processor` on AIS_RAW (spec §7.3).
 *
 * - `orderBySubject: false`: the subject is the feed (`ais.raw.v1.<source>`),
 *   not the vessel; per-vessel order is kept by the pipeline instead.
 * - High concurrency: handlers wait for their batch to commit, so batches
 *   can only fill up with many messages in flight.
 * - `exclusive`: one active processor (per-vessel state in memory); further
 *   replicas stand by and take over when it stops pulling for
 *   {@link PROCESSOR_PINNED_TTL_MS}, or at once when it stops gracefully.
 *   When this instance becomes the active one, the in-memory vessel states
 *   are dropped before its first report ({@link onConsumerActivated}).
 */
@Injectable()
export class RawReportConsumer implements ExclusiveConsumerListener {
  private readonly logger = new Logger(RawReportConsumer.name);

  constructor(private readonly pipeline: PositionPipelineService) {}

  @EventHandler({
    consumer: RAW_REPORT_CONSUMER,
    concurrency: 1024,
    orderBySubject: false,
    maxAckPending: 4096,
    exclusive: { pinnedTtlMs: PROCESSOR_PINNED_TTL_MS },
  })
  async onRawReport(event: ConsumerEnvelope<'ais-processor'>): Promise<void> {
    await this.pipeline.process(event.data);
  }

  /**
   * This instance became the active processor: another instance may have
   * recorded vessels while it stood by (failover, failback), so every
   * vessel state it holds in memory is dropped; the next report of a
   * vessel loads it from Valkey or the database. The kit dispatches the
   * first report of the active period only after this returned.
   */
  onConsumerActivated(event: ExclusiveConsumerEvent): void {
    const dropped = this.pipeline.resetVesselStates();
    this.logger.log(
      `${event.consumer} is active (pin ${event.pinId ?? '?'}${event.previous === undefined ? '' : `, previously ${event.previous}`}): dropped ${dropped} cached vessel state(s)`,
    );
  }
}
