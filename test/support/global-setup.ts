import { testInfraGlobalSetup } from '@darmawanweb/ais-its-nest/testing';

// The global setup runs in vitest's main process, which `test.env` does not
// reach: disable Ryuk here (the teardown stops the containers).
process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';

/**
 * TimescaleDB/PostGIS, NATS (JetStream) and Valkey, started once for every
 * integration test file (`testInfra(...)` reads the endpoints) and stopped
 * at the end of the run.
 */
export const setup = testInfraGlobalSetup({
  postgres: true,
  nats: true,
  redis: true,
});
