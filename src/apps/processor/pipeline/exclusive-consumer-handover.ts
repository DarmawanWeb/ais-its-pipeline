import { InjectConfig } from '@darmawanweb/ais-its-nest';
import {
  EventConsumers,
  EXCLUSIVE_CONSUMER_GROUP,
  NatsClient,
} from '@darmawanweb/ais-its-nest/nats';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
} from '@nestjs/common';

import type { ProcessorConfig } from '../config.js';
import { PositionWriter } from './position-writer.js';
import {
  PROCESSOR_PINNED_TTL_MS,
  RAW_REPORT_CONSUMER,
} from './raw-report.consumer.js';

/**
 * Time left after the consumer stopped for the writer drain, the outbox
 * relay, NATS and the pool [ms]: the kit exits the process
 * `SHUTDOWN_TIMEOUT_MS` after the signal (its own consumer drain keeps the
 * same margin: 25 s of the default 30 s).
 */
export const SHUTDOWN_HEADROOM_MS = 5000;

/** Longest wait for in-flight reports before the pin is released [ms]. */
export function handoverBudgetMs(shutdownTimeoutMs: number): number {
  return shutdownTimeoutMs > 0
    ? Math.max(1000, shutdownTimeoutMs - SHUTDOWN_HEADROOM_MS)
    : 25_000;
}

/**
 * WORKAROUND for @darmawanweb/ais-its-nest 0.2.0 (reported as a platform
 * issue): the kit neither releases the pin of an exclusive consumer when
 * the application stops nor re-pulls when it is unpinned, so after a
 * graceful stop of the active processor the standby would wait for the
 * {@link PROCESSOR_PINNED_TTL_MS} pin to lapse. Before shutdown this stops
 * the `ais-processor` consumer itself — pulling ends, in-flight reports
 * finish (the kit's own stop later is a no-op) — and then unpins it
 * (`$JS.API.CONSUMER.UNPIN`), so the server pins a standby at once. Remove
 * it once the kit unpins on shutdown.
 *
 * It depends on {@link PositionWriter} so Nest runs it before the writer
 * drains (dependents shut down first): in-flight reports still get written.
 */
@Injectable()
export class ExclusiveConsumerHandover implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ExclusiveConsumerHandover.name);

  constructor(
    private readonly consumers: EventConsumers,
    private readonly nats: NatsClient,
    // Injected for the shutdown order only (see above).
    readonly writer: PositionWriter,
    @InjectConfig() private readonly config: ProcessorConfig,
  ) {}

  async beforeApplicationShutdown(): Promise<void> {
    const name = `${this.config.NATS_DURABLE_PREFIX}${RAW_REPORT_CONSUMER}`;
    const runner = this.consumers.running.find((r) => r.name === name);
    if (runner === undefined) return;
    await runner.stop(handoverBudgetMs(this.config.SHUTDOWN_TIMEOUT_MS));
    try {
      const { manager } = await this.nats.ready();
      await manager.consumers.unpin('AIS_RAW', name, EXCLUSIVE_CONSUMER_GROUP);
      this.logger.log(`Released the pin of ${name}: a standby takes over now`);
    } catch (error) {
      this.logger.warn(
        `Releasing the pin of ${name} failed; a standby takes over within ${PROCESSOR_PINNED_TTL_MS / 1000} s: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
