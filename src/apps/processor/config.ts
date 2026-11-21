import { join } from 'node:path';

import {
  type AppConfig,
  defineConfig,
  envInteger,
  ServiceNameSchema,
  SqlIdentifierSchema,
} from '@darmawanweb/ais-its-nest';
import * as z from 'zod';

import { DEFAULT_DEDUP_MIN_DISTANCE_M } from '../../shared/domain/movement.js';
import { SERVICE } from '../../shared/service.js';

/**
 * Environment of the processor (spec §4, §13.2): the platform base variables
 * with this process's defaults (schema `ais`, Valkey), the legacy rule
 * parameters and the writer's batching.
 */
export const processorConfigSchema = defineConfig({
  SERVICE_NAME: ServiceNameSchema.default(SERVICE.processor.name),
  SERVICE_VERSION: z.string().min(1).default(SERVICE.version),
  PORT: envInteger(0, 65_535).default(SERVICE.processor.port),
  DATABASE_SCHEMA: SqlIdentifierSchema.default(SERVICE.processor.schema),
  /** A newer report closer than this to the latest position is skipped [m]. */
  AIS_DEDUP_MIN_DISTANCE_M: z.coerce
    .number()
    .min(0)
    .max(10_000)
    .default(DEFAULT_DEDUP_MIN_DISTANCE_M),
  /** Coast geometry (GeoJSON FeatureCollection), loaded once at startup. */
  GEO_COASTLINE_PATH: z
    .string()
    .min(1)
    .default(join(SERVICE.root, 'data', 'coastline.geojson')),
  /** Most rows of one write transaction. */
  PROCESSOR_BATCH_SIZE: envInteger(1, 10_000).default(500),
  /** Longest a recorded row waits for its write transaction [ms]. */
  PROCESSOR_FLUSH_MS: envInteger(1, 60_000).default(1000),
  /** Vessels whose last position stays in memory in front of Valkey. */
  AIS_STATE_CACHE_SIZE: envInteger(100, 10_000_000).default(100_000),
  /** Lifetime of a vessel's `ais:last:<mmsi>` hash after its last update [days]. */
  AIS_STATE_TTL_DAYS: envInteger(1, 3650).default(30),
});

/** Validated processor configuration. */
export type ProcessorConfig = AppConfig<typeof processorConfigSchema>;
