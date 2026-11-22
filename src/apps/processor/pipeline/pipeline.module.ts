import { OutboxModule } from '@darmawanweb/ais-its-nest/nats';
import { Module } from '@nestjs/common';

import { CoastlineService } from '../coastline/coastline.service.js';
import { ExclusiveConsumerHandover } from './exclusive-consumer-handover.js';
import { LastPositionStore } from './last-position.store.js';
import { PipelineMetrics } from './pipeline.metrics.js';
import { PositionPipelineService } from './position-pipeline.service.js';
import { PositionWriter } from './position-writer.js';
import { PositionsWriteRepository } from './positions-write.repository.js';
import { RawReportConsumer } from './raw-report.consumer.js';
import { VesselLatestRepository } from './vessel-latest.repository.js';

/**
 * Relay of the position events (table `outbox`, migration 0003): idle poll
 * 200 ms (woken after every batch with recorded positions), up to 500 events
 * per pass, published rows deleted after 10 minutes (the events stay in
 * AIS_POSITION for 7 days). Static: the kit's OutboxModule has no async
 * (config-driven) variant.
 */
export const POSITION_OUTBOX = {
  pollIntervalMs: 200,
  batchSize: 500,
  retentionMs: 10 * 60_000,
} as const;

/** AIS_RAW → enriched positions (DB rows + outbox, Valkey) → AIS_POSITION. */
@Module({
  imports: [OutboxModule.forRoot(POSITION_OUTBOX)],
  providers: [
    CoastlineService,
    ExclusiveConsumerHandover,
    LastPositionStore,
    PipelineMetrics,
    PositionPipelineService,
    PositionWriter,
    PositionsWriteRepository,
    RawReportConsumer,
    VesselLatestRepository,
  ],
  exports: [PositionPipelineService],
})
export class PipelineModule {}
