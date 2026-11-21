import { Module } from '@nestjs/common';

import { IngestController } from './ingest.controller.js';
import { IngestMetrics } from './ingest.metrics.js';
import { IngestService } from './ingest.service.js';
import { RawReportPublisher } from './raw-report.publisher.js';

/** Normalization and publication of AIS reports, `POST /ingest/ais`. */
@Module({
  controllers: [IngestController],
  providers: [IngestService, IngestMetrics, RawReportPublisher],
  exports: [IngestService, IngestMetrics],
})
export class IngestModule {}
