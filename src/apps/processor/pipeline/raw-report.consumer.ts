import {
  EventHandler,
  type ConsumerEnvelope,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';

import { PositionPipelineService } from './position-pipeline.service.js';

/**
 * Durable consumer `ais-processor` on AIS_RAW (spec §7.3).
 *
 * - `orderBySubject: false`: the subject is the feed (`ais.raw.v1.<source>`),
 *   not the vessel; per-vessel order is kept by the pipeline instead.
 * - High concurrency: handlers wait for their batch to commit, so batches
 *   can only fill up with many messages in flight.
 * - `exclusive`: one active processor (per-vessel state in memory); further
 *   replicas stand by and take over when it stops pulling.
 */
@Injectable()
export class RawReportConsumer {
  constructor(private readonly pipeline: PositionPipelineService) {}

  @EventHandler({
    consumer: 'ais-processor',
    concurrency: 1024,
    orderBySubject: false,
    maxAckPending: 4096,
    exclusive: true,
  })
  async onRawReport(event: ConsumerEnvelope<'ais-processor'>): Promise<void> {
    await this.pipeline.process(event.data);
  }
}
