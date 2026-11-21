import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';

import { PUSHER_MAX_MESSAGE_BYTES } from './pusher/pusher.gateway.js';

/** Request bodies up to 1000 legacy messages with headroom [bytes]. */
export const INGESTOR_BODY_LIMIT_BYTES = PUSHER_MAX_MESSAGE_BYTES;

/**
 * Attaches the socket.io server of the pusher gateway to the Fastify HTTP
 * server (same port as the REST API). Used by `server.ts` and the tests.
 */
export function configureIngestorApp(app: NestFastifyApplication): void {
  app.useWebSocketAdapter(new IoAdapter(app));
}
