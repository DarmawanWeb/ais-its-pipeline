import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { OutboxRelay } from '@darmawanweb/ais-its-nest/nats';
import { type BeforeApplicationShutdown, Injectable } from '@nestjs/common';

import type { ProcessorConfig } from '../config.js';
import { BatchWriter } from './batch-writer.js';
import { PipelineMetrics } from './pipeline.metrics.js';
import { PositionsWriteRepository } from './positions-write.repository.js';
import type { PositionRow, RowResolution } from './resolve-batch.js';

/**
 * Batched position writes (spec §13.2: ≤ `PROCESSOR_BATCH_SIZE` rows per
 * transaction, a row waits at most `PROCESSOR_FLUSH_MS`), see
 * {@link BatchWriter}. After a batch with recorded positions committed, the
 * outbox relay is woken so their events are published right away.
 */
@Injectable()
export class PositionWriter implements BeforeApplicationShutdown {
  private readonly batches: BatchWriter<PositionRow, RowResolution>;

  constructor(
    repository: PositionsWriteRepository,
    relay: OutboxRelay,
    metrics: PipelineMetrics,
    @InjectConfig() config: ProcessorConfig,
  ) {
    this.batches = new BatchWriter<PositionRow, RowResolution>(
      async (rows) => {
        const stop = metrics.instruments.batchDuration.startTimer();
        try {
          const results = await repository.writeBatch(rows);
          if (results.some((result) => result.outcome === 'recorded'))
            relay.notify();
          return results;
        } finally {
          stop();
          metrics.instruments.batchRows.observe(rows.length);
        }
      },
      {
        maxRows: config.PROCESSOR_BATCH_SIZE,
        maxDelayMs: config.PROCESSOR_FLUSH_MS,
      },
    );
  }

  /** Resolves with the row's resolution once its batch is committed. */
  write(row: PositionRow): Promise<RowResolution> {
    return this.batches.write(row);
  }

  /** Writes what is buffered before the pool closes. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.batches.drain();
  }
}
