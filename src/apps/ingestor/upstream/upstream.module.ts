import { Module } from '@nestjs/common';

import { IngestModule } from '../ingest/ingest.module.js';
import { UpstreamFeedsService } from './upstream-feeds.service.js';

/** socket.io clients of the upstream AIS servers (`primary`, `batam`). */
@Module({
  imports: [IngestModule],
  providers: [UpstreamFeedsService],
  exports: [UpstreamFeedsService],
})
export class UpstreamModule {}
