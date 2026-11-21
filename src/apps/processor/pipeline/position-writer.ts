import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { type BeforeApplicationShutdown, Injectable } from '@nestjs/common';

import type { ProcessorConfig } from '../config.js';
import { BatchWriter } from './batch-writer.js';
import { PipelineMetrics } from './pipeline.metrics.js';
import {
  type PositionRow,
  PositionsWriteRepository,
} from './positions-write.repository.js';

/**
 * Batched position writes (spec §13.2: ≤ `PROCESSOR_BATCH_SIZE` rows per
 * transaction, a row waits at most `PROCESSOR_FLUSH_MS`), see {@link BatchWriter}.
 */
@Injectable()
export class PositionWriter implements BeforeApplicationShutdown {
  private readonly batches: BatchWriter<PositionRow>;

  constructor(
    repository: PositionsWriteRepository,
    metrics: PipelineMetrics,
    @InjectConfig() config: ProcessorConfig,
  ) {
    this.batches = new BatchWriter<PositionRow>(
      async (rows) => {
        const stop = metrics.instruments.batchDuration.startTimer();
        try {
          await repository.writeBatch(rows);
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

  /** Resolves when the row's batch is committed. */
  write(row: PositionRow): Promise<void> {
    return this.batches.write(row);
  }

  /** Writes what is buffered before the pool closes. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.batches.drain();
  }
}
