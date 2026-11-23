import 'reflect-metadata';

import { bootstrapService, loadConfig } from '@darmawanweb/ais-its-nest';

import { PROCESSOR_CORS } from './bootstrap.js';
import { processorConfigSchema } from './config.js';
import { PROCESSOR_OPENAPI } from './openapi.options.js';
import { ProcessorModule } from './processor.module.js';

// Connect PostgreSQL, migrate, connect NATS (ensure AIS_POSITION) and Valkey,
// load the coastline (onModuleInit) → start the consumers ais-processor and
// ais-processor-fleet and the outbox relay (onApplicationBootstrap) → listen
// on HOST:PORT. SIGTERM turns readiness to 503, drains the consumers (the pin
// of ais-processor is released, so a standby takes over at once), the
// writer and the relay, then closes NATS and the pool.
await bootstrapService({
  appModule: ProcessorModule,
  config: loadConfig(processorConfigSchema),
  openapi: PROCESSOR_OPENAPI,
  cors: PROCESSOR_CORS,
});
