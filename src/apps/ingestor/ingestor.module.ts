import { AuthModule } from '@darmawanweb/ais-its-nest/auth';
import { NatsModule } from '@darmawanweb/ais-its-nest/nats';
import { Module } from '@nestjs/common';

import { IngestModule } from './ingest/ingest.module.js';
import { PusherModule } from './pusher/pusher.module.js';
import { StatusModule } from './status/status.module.js';
import { UpstreamModule } from './upstream/upstream.module.js';

/**
 * Root module of the ingestor (stateless, no database): upstream feeds,
 * pushers (socket.io and REST) → normalized `ais.raw.received.v1` in
 * AIS_RAW. `bootstrapService()` wraps it in the kit's platform root module.
 */
@Module({
  imports: [
    // The ingestor PRODUCES to AIS_RAW: created / widened at boot (spec §7.2).
    NatsModule.forRoot({ streams: ['AIS_RAW'] }),
    // Default-deny guard; API keys are introspected through AUTH_INTERNAL_URL.
    AuthModule.forRoot(),
    IngestModule,
    UpstreamModule,
    PusherModule,
    StatusModule,
  ],
})
export class IngestorModule {}
