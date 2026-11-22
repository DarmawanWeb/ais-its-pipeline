import {
  type AppConfig,
  defineConfig,
  envInteger,
  envUrl,
  ServiceNameSchema,
} from '@darmawanweb/ais-its-nest';
import * as z from 'zod';

import {
  AIS_UTC_MODES,
  DEFAULT_MAX_POSITION_AGE_MS,
} from '../../shared/domain/normalize.js';
import { SERVICE } from '../../shared/service.js';

/** Schemes the upstream socket.io servers may use. */
const UPSTREAM_PROTOCOLS = ['http', 'https', 'ws', 'wss'] as const;

/**
 * Environment of the ingestor (spec §4, §13.2): the platform base variables
 * with this process's defaults (no database), the upstream feeds and the
 * pusher limits. An empty upstream URL disables that feed.
 */
export const ingestorConfigSchema = defineConfig({
  SERVICE_NAME: ServiceNameSchema.default(SERVICE.ingestor.name),
  SERVICE_VERSION: z.string().min(1).default(SERVICE.version),
  PORT: envInteger(0, 65_535).default(SERVICE.ingestor.port),
  /** Primary upstream socket.io server (legacy `websocket.url`). */
  AIS_PRIMARY_URL: envUrl(UPSTREAM_PROTOCOLS).optional(),
  /** Batam upstream socket.io server (legacy `websocket.batam_url`). */
  AIS_BATAM_URL: envUrl(UPSTREAM_PROTOCOLS).optional(),
  /** Handshake `auth.token` sent to both upstreams. */
  AIS_UPSTREAM_TOKEN: z.string().min(1).optional(),
  /** First reconnection delay of an upstream, ms (doubles up to the maximum, ±50 % jitter). */
  AIS_UPSTREAM_RECONNECT_MIN_MS: envInteger(100, 600_000).default(1000),
  AIS_UPSTREAM_RECONNECT_MAX_MS: envInteger(100, 3_600_000).default(30_000),
  /** Sustained messages per second one pusher connection may send. */
  INGEST_SOCKET_RATE_PER_S: envInteger(1, 1_000_000).default(200),
  /** Burst size of a pusher connection (token bucket capacity), messages. */
  INGEST_SOCKET_BURST: envInteger(1, 10_000_000).default(2000),
  /** Upstream reports waiting for their publish ack before new ones are dropped. */
  INGEST_MAX_PENDING_PUBLISHES: envInteger(1, 1_000_000).default(10_000),
  /**
   * While the API-key introspection is unavailable, a connected pusher keeps
   * sending with its last verified key for this long after that verification
   * [s]; then its events are refused as retryable (`SERVICE_UNAVAILABLE`),
   * the connection stays open. `0` refuses at once.
   */
  INGEST_SOCKET_AUTH_GRACE_S: envInteger(0, 86_400).default(300),
  /**
   * Reading of the upstream `utc` field: `legacy` (spec §13.2 parity,
   * position time = timestamp − utc s) or `itu` (the ITU-R M.1371 time
   * stamp, the UTC second of the report). Switch only once the provider
   * confirmed the meaning; `aisits_ais_utc_second_lag_seconds` shows which
   * reading the data fits.
   */
  AIS_UTC_MODE: z.enum(AIS_UTC_MODES).default('legacy'),
  /**
   * Oldest accepted position time before its reception [s]; older reports
   * are rejected (`STALE_TIMESTAMP`). At most the 180-day raw retention.
   */
  INGEST_MAX_POSITION_AGE_S: envInteger(60, 180 * 86_400).default(
    DEFAULT_MAX_POSITION_AGE_MS / 1000,
  ),
});

/** Validated ingestor configuration. */
export type IngestorConfig = AppConfig<typeof ingestorConfigSchema>;
