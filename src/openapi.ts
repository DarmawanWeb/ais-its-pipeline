import 'reflect-metadata';

import { exportOpenApi } from '@darmawanweb/ais-its-nest';

import { ingestorConfigSchema } from './apps/ingestor/config.js';
import { IngestorModule } from './apps/ingestor/ingestor.module.js';
import { INGESTOR_OPENAPI } from './apps/ingestor/openapi.options.js';
import { processorConfigSchema } from './apps/processor/config.js';
import { PROCESSOR_OPENAPI } from './apps/processor/openapi.options.js';
import { ProcessorModule } from './apps/processor/processor.module.js';

// `pnpm openapi`: writes one document per process from the real root modules
// (openapi.ingestor.json, openapi.processor.json — each process serves its own
// at /openapi.json); `--check` (CI, `pnpm openapi:check`) fails when a
// committed file is stale. No lifecycle hook runs, so nothing connects; the
// configuration comes from the schema defaults only (`env: {}`).
const check = process.argv.includes('--check');

await exportOpenApi({
  appModule: IngestorModule,
  configSchema: ingestorConfigSchema,
  env: {},
  openapi: INGESTOR_OPENAPI,
  outFile: 'openapi.ingestor.json',
  check,
});
await exportOpenApi({
  appModule: ProcessorModule,
  configSchema: processorConfigSchema,
  env: {},
  openapi: PROCESSOR_OPENAPI,
  outFile: 'openapi.processor.json',
  check,
});
