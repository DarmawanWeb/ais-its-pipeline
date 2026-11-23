import { APP_CONFIG } from '@darmawanweb/ais-its-nest';
import {
  OutboxModule,
  type OutboxModuleOptions,
} from '@darmawanweb/ais-its-nest/nats';
import { Module } from '@nestjs/common';

import { CoastlineService } from '../coastline/coastline.service.js';
import type { ProcessorConfig } from '../config.js';
import { LastPositionStore } from './last-position.store.js';
import { PipelineMetrics } from './pipeline.metrics.js';
import { PositionPipelineService } from './position-pipeline.service.js';
import { PositionWriter } from './position-writer.js';
import { PositionsWriteRepository } from './positions-write.repository.js';
import { RawReportConsumer } from './raw-report.consumer.js';
import { VesselLatestRepository } from './vessel-latest.repository.js';

/**
 * Relay of the position events (table `outbox`, migrations 0003 and 0004)
 * from the `OUTBOX_*` variables. The mode is `per-key` explicitly: 0004
 * gives the table `seq` and `next_attempt_at`, and a table without them
 * must fail the start rather than fall back to the serial relay. Every
 * replica relays (`FOR UPDATE SKIP LOCKED`, the standby included); the
 * events of one vessel (entity key = MMSI) are published in `seq` order, up
 * to `OUTBOX_PUBLISH_CONCURRENCY` vessels at once, and a failing vessel
 * backs off on its own while the others keep flowing. Published rows are
 * deleted after `OUTBOX_RETENTION_MINUTES` (the events stay in
 * AIS_POSITION for 7 days).
 */
export function outboxModuleOptions(
  config: ProcessorConfig,
): OutboxModuleOptions {
  return {
    mode: 'per-key',
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    batchSize: config.OUTBOX_BATCH_SIZE,
    publishConcurrency: config.OUTBOX_PUBLISH_CONCURRENCY,
    retentionMs: config.OUTBOX_RETENTION_MINUTES * 60_000,
    retry: {
      baseMs: config.OUTBOX_RETRY_BASE_MS,
      maxMs: config.OUTBOX_RETRY_MAX_MS,
    },
  };
}

/** AIS_RAW → enriched positions (DB rows + outbox, Valkey) → AIS_POSITION. */
@Module({
  imports: [
    OutboxModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: ProcessorConfig) => outboxModuleOptions(config),
    }),
  ],
  providers: [
    CoastlineService,
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
