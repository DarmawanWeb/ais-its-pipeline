import { runMigrationsCli } from '@darmawanweb/ais-its-nest/db';

import { processorConfigSchema } from './apps/processor/config.js';

// `pnpm migrate`: applies migrations/ to DATABASE_SCHEMA (ais) under an
// advisory lock (the processor runs the same migrator at startup when
// DB_MIGRATE_ON_BOOT=true). The ingestor has no database.
await runMigrationsCli({ configSchema: processorConfigSchema });
