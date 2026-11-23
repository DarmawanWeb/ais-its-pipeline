import type { CorsFeatureOptions } from '@darmawanweb/ais-its-nest/http';

import { TRUNCATED_HEADER } from './positions/positions.controller.js';

/**
 * CORS of the processor, used by `server.ts` and the tests: besides the
 * kit's defaults (`X-Request-Id`, `Retry-After`, `WWW-Authenticate`, `ETag`,
 * `Location`), cross-origin browser clients may read `X-Truncated` of
 * `GET /ais/latest`. No other processor response carries a header of its
 * own (`X-Total-Count` is not used: lists return their totals in the body).
 */
export const PROCESSOR_CORS: CorsFeatureOptions = {
  exposedHeaders: [TRUNCATED_HEADER],
};
