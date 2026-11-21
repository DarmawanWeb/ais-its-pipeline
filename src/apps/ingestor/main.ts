import { existsSync } from 'node:fs';

import { startTelemetry } from '@darmawanweb/ais-its-nest/telemetry';

import { SERVICE } from '../../shared/service.js';

// Entrypoint of the ingestor: `node dist/apps/ingestor/main.js`.
// OpenTelemetry patches modules while they load, so it starts before the
// application is imported. OTEL_* may come from .env (variables already set win).
if (existsSync('.env')) process.loadEnvFile('.env');

await startTelemetry({
  serviceName: process.env.SERVICE_NAME ?? SERVICE.ingestor.name,
  serviceVersion: process.env.SERVICE_VERSION ?? SERVICE.version,
});
await import('./server.js');
