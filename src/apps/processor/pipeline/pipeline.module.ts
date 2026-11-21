import { Module } from '@nestjs/common';

import { CoastlineService } from '../coastline/coastline.service.js';
import { LastPositionStore } from './last-position.store.js';
import { PipelineMetrics } from './pipeline.metrics.js';
import { PositionEventsPublisher } from './position-events.publisher.js';
import { PositionPipelineService } from './position-pipeline.service.js';
import { PositionWriter } from './position-writer.js';
import { PositionsWriteRepository } from './positions-write.repository.js';
import { RawReportConsumer } from './raw-report.consumer.js';
import { VesselLatestRepository } from './vessel-latest.repository.js';

/** AIS_RAW → enriched positions (DB, Valkey) → AIS_POSITION. */
@Module({
  providers: [
    CoastlineService,
    LastPositionStore,
    PipelineMetrics,
    PositionEventsPublisher,
    PositionPipelineService,
    PositionWriter,
    PositionsWriteRepository,
    RawReportConsumer,
    VesselLatestRepository,
  ],
  exports: [PositionPipelineService],
})
export class PipelineModule {}
