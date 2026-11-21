import { Module } from '@nestjs/common';

import { IngestModule } from '../ingest/ingest.module.js';
import { PusherAuthenticator } from './pusher-authenticator.js';
import { PusherGateway } from './pusher.gateway.js';

/** socket.io endpoint `/api/v2/ingest/socket` for API-key pushers. */
@Module({
  imports: [IngestModule],
  providers: [PusherGateway, PusherAuthenticator],
  exports: [PusherGateway],
})
export class PusherModule {}
