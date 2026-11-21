import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { InjectRedis, type Redis } from '@darmawanweb/ais-its-nest/redis';
import { Injectable } from '@nestjs/common';

import type { ProcessorConfig } from '../config.js';
import {
  decodeLastPosition,
  encodeLastPosition,
  lastPositionKey,
} from './last-position.codec.js';
import { PipelineMetrics } from './pipeline.metrics.js';
import type { RecordedPosition } from './recorded-position.js';
import { VesselLatestRepository } from './vessel-latest.repository.js';

/**
 * Last committed position per vessel, shared by processor instances: the
 * Valkey hash `ais:last:<mmsi>` (refreshed TTL `AIS_STATE_TTL_DAYS`) with
 * `ais.vessel_latest` as the durable fallback (cold Valkey, expired key).
 * Errors propagate: a report is retried rather than processed without its
 * vessel's history.
 */
@Injectable()
export class LastPositionStore {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly latest: VesselLatestRepository,
    private readonly metrics: PipelineMetrics,
    @InjectConfig() private readonly config: ProcessorConfig,
  ) {}

  /** The vessel's last committed position, `null` for a vessel never seen. */
  async load(mmsi: number): Promise<RecordedPosition | null> {
    const cached = decodeLastPosition(
      await this.redis.hgetall(lastPositionKey(mmsi)),
    );
    if (cached !== null) {
      this.metrics.stateLoaded('valkey');
      return cached;
    }
    const stored = await this.latest.find(mmsi);
    this.metrics.stateLoaded(stored === null ? 'none' : 'database');
    return stored;
  }

  /** Stores the vessel's new last position (after it was written and published). */
  async save(position: RecordedPosition): Promise<void> {
    const key = lastPositionKey(position.mmsi);
    const results = await this.redis
      .multi()
      .hset(key, encodeLastPosition(position))
      .expire(key, this.config.AIS_STATE_TTL_DAYS * 86_400)
      .exec();
    const failure = results?.find(([error]) => error !== null)?.[0];
    if (results === null || failure !== undefined) {
      throw new Error(
        `Saving ${key} failed: ${failure?.message ?? 'transaction aborted'}`,
      );
    }
  }
}
