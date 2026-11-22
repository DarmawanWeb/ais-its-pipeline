import { createHash } from 'node:crypto';

import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { InjectRedis, type Redis } from '@darmawanweb/ais-its-nest/redis';
import { Injectable, Logger } from '@nestjs/common';

import type { ProcessorConfig } from '../config.js';
import {
  decodeLastPosition,
  encodeLastPosition,
  LAST_POSITION_TIME_MS_FIELD,
  lastPositionKey,
  SAVE_LAST_POSITION_SCRIPT,
} from './last-position.codec.js';
import { PipelineMetrics } from './pipeline.metrics.js';
import type { RecordedPosition } from './recorded-position.js';
import type { VesselStateSource } from './vessel-tracker.js';
import { VesselLatestRepository } from './vessel-latest.repository.js';

const SAVE_SCRIPT_SHA = createHash('sha1')
  .update(SAVE_LAST_POSITION_SCRIPT)
  .digest('hex');

/** Shortest interval between two warnings about Valkey failures [ms]. */
const WARNING_INTERVAL_MS = 10_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Last committed position per vessel, shared by processor instances: the
 * Valkey hash `ais:last:<mmsi>` (refreshed TTL `AIS_STATE_TTL_DAYS`) in front
 * of `ais.vessel_latest`, which stays authoritative (every write batch reads
 * it under lock, see `PositionsWriteRepository`).
 *
 * Valkey is a cache: when it fails, loads fall back to the database, a
 * cached state is kept, and a failed save is logged and counted — the
 * pipeline keeps going on the database alone. Saves are monotonic
 * ({@link SAVE_LAST_POSITION_SCRIPT}), so a late save never moves a vessel
 * back.
 */
@Injectable()
export class LastPositionStore implements VesselStateSource {
  private readonly logger = new Logger(LastPositionStore.name);
  private lastWarningAt = 0;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly latest: VesselLatestRepository,
    private readonly metrics: PipelineMetrics,
    @InjectConfig() private readonly config: ProcessorConfig,
  ) {}

  /**
   * The vessel's last committed position, `null` for a vessel never seen.
   *
   * @throws when the database fallback fails (the report is retried)
   */
  async load(mmsi: number): Promise<RecordedPosition | null> {
    try {
      const cached = decodeLastPosition(
        await this.redis.hgetall(lastPositionKey(mmsi)),
      );
      if (cached !== null) {
        this.metrics.stateLoaded('valkey');
        return cached;
      }
    } catch (error) {
      this.valkeyFailed('load', error);
    }
    const stored = await this.latest.find(mmsi);
    this.metrics.stateLoaded(stored === null ? 'none' : 'database');
    return stored;
  }

  /**
   * Whether `cached` (this instance's in-memory state) is still the
   * vessel's last position: `false` when Valkey holds a newer one (another
   * replica recorded the vessel). An older or missing hash keeps the cache
   * (this instance's save failed or Valkey lost the key), as does a Valkey
   * failure.
   */
  async isCurrent(cached: RecordedPosition): Promise<boolean> {
    try {
      const stored = await this.redis.hget(
        lastPositionKey(cached.mmsi),
        LAST_POSITION_TIME_MS_FIELD,
      );
      const current =
        stored === null || Number(stored) <= cached.time.getTime();
      this.metrics.stateRevalidated(current ? 'current' : 'stale');
      return current;
    } catch (error) {
      this.valkeyFailed('revalidate', error);
      return true;
    }
  }

  /** Stores the vessel's last position unless a newer one is stored; never throws. */
  async save(position: RecordedPosition): Promise<void> {
    const key = lastPositionKey(position.mmsi);
    const args = [
      String(this.config.AIS_STATE_TTL_DAYS * 86_400),
      String(position.time.getTime()),
      ...Object.entries(encodeLastPosition(position)).flat(),
    ];
    try {
      await this.redis
        .evalsha(SAVE_SCRIPT_SHA, 1, key, ...args)
        .catch((error: unknown) => {
          if (!errorMessage(error).includes('NOSCRIPT')) throw error;
          return this.redis.eval(SAVE_LAST_POSITION_SCRIPT, 1, key, ...args);
        });
    } catch (error) {
      this.valkeyFailed('save', error);
    }
  }

  private valkeyFailed(
    operation: 'load' | 'revalidate' | 'save',
    error: unknown,
  ): void {
    this.metrics.stateError(operation);
    const now = Date.now();
    if (now - this.lastWarningAt < WARNING_INTERVAL_MS) return;
    this.lastWarningAt = now;
    this.logger.warn(
      `Valkey ${operation} of a vessel's last position failed (falling back to the database): ${errorMessage(error)}`,
    );
  }
}
