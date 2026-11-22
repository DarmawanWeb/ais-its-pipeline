import {
  EventHandler,
  type ConsumerEnvelope,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';

import { PositionPipelineService } from './position-pipeline.service.js';

/** Durable consumer of the processor on AIS_RAW (spec §7.3). */
export const RAW_REPORT_CONSUMER = 'ais-processor';

/**
 * How long the server keeps the active instance pinned without a pull [ms].
 * It must stay well above the kit's pull expiry (30 s): a pull is renewed
 * when the previous one expires, and up to two missed heartbeats (another
 * 30 s) late when its expiry notice is lost, so a TTL ≤ 60 s unpins even a
 * healthy, idle single instance (a 30 s TTL did, stalling the next report
 * for ~40 s). The price is the failover delay: a crashed active instance is
 * replaced by a standby after up to this long; a graceful stop hands over
 * at once ({@link ExclusiveConsumerHandover}).
 */
export const PROCESSOR_PINNED_TTL_MS = 90_000;

/**
 * Durable consumer `ais-processor` on AIS_RAW (spec §7.3).
 *
 * - `orderBySubject: false`: the subject is the feed (`ais.raw.v1.<source>`),
 *   not the vessel; per-vessel order is kept by the pipeline instead.
 * - High concurrency: handlers wait for their batch to commit, so batches
 *   can only fill up with many messages in flight.
 * - `exclusive`: one active processor (per-vessel state in memory); further
 *   replicas stand by and take over when it stops pulling for
 *   {@link PROCESSOR_PINNED_TTL_MS} or hands over on shutdown.
 */
@Injectable()
export class RawReportConsumer {
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
}
