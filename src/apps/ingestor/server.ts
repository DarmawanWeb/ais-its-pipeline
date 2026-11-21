import 'reflect-metadata';

import { bootstrapService, loadConfig } from '@darmawanweb/ais-its-nest';

import {
  configureIngestorApp,
  INGESTOR_BODY_LIMIT_BYTES,
} from './bootstrap.js';
import { ingestorConfigSchema } from './config.js';
import { IngestorModule } from './ingestor.module.js';
import { INGESTOR_OPENAPI } from './openapi.options.js';

// Connect NATS and ensure AIS_RAW (onModuleInit) → start the upstream feeds
// (onApplicationBootstrap) → listen on HOST:PORT (REST + socket.io). SIGTERM
// closes the feeds and pushers, then drains NATS.
await bootstrapService({
  appModule: IngestorModule,
  config: loadConfig(ingestorConfigSchema),
  openapi: INGESTOR_OPENAPI,
  adapter: { bodyLimitBytes: INGESTOR_BODY_LIMIT_BYTES },
  configure: configureIngestorApp,
});
