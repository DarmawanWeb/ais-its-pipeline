import type { OpenApiOptions } from '@darmawanweb/ais-its-nest';

import { SERVICE } from '../../shared/service.js';

/** OpenAPI document of the processor (`/docs`, `/openapi.json`, `openapi.processor.json`). */
export const PROCESSOR_OPENAPI: OpenApiOptions = {
  title: `AIS Maritime Intelligence — ${SERVICE.title}: processor`,
  version: SERVICE.version,
  description:
    'AIS processing and query API (spec §13.2): latest positions, tracks (raw / 1-minute), ' +
    'pair tracks and live statistics. AIS data is shared across tenants (`ais:read`; API keys with `ais:read`).',
  tags: [
    { name: 'ais', description: 'AIS positions, tracks and statistics' },
    {
      name: 'methodology',
      description: 'Methods of the methodology catalog implemented here',
    },
  ],
};
