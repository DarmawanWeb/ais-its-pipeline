import type { OpenApiOptions } from '@darmawanweb/ais-its-nest';

import { SERVICE } from '../../shared/service.js';

/** OpenAPI document of the ingestor (`/docs`, `/openapi.json`, `openapi.ingestor.json`). */
export const INGESTOR_OPENAPI: OpenApiOptions = {
  title: `AIS Maritime Intelligence — ${SERVICE.title}: ingestor`,
  version: SERVICE.version,
  description:
    'AIS ingestion (spec §13.2): REST and socket.io (`/api/v2/ingest/socket`, event `ais:data`, ' +
    'handshake `auth: { apiKey }` with scope `ais:ingest`) pushers and the upstream feeds, ' +
    'normalized into `ais.raw.received.v1` (stream AIS_RAW).',
  tags: [
    { name: 'ingest', description: 'AIS report ingestion and feed status' },
  ],
};
