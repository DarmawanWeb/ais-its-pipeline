import { Module } from '@nestjs/common';

import { IngestModule } from '../ingest/ingest.module.js';
import { PusherModule } from '../pusher/pusher.module.js';
import { UpstreamModule } from '../upstream/upstream.module.js';
import { StatusController } from './status.controller.js';
import { StatusService } from './status.service.js';

/** `GET /ingest/status` for operators. */
@Module({
  imports: [IngestModule, UpstreamModule, PusherModule],
  controllers: [StatusController],
  providers: [StatusService],
})
export class StatusModule {}
