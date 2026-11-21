import { ForbiddenError, InjectConfig } from '@darmawanweb/ais-its-nest';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { Injectable } from '@nestjs/common';

import type { IngestorConfig } from '../config.js';
import {
  IngestMetrics,
  type SourceActivity,
} from '../ingest/ingest.metrics.js';
import { IngestService } from '../ingest/ingest.service.js';
import { PusherGateway } from '../pusher/pusher.gateway.js';
import type { UpstreamFeedStatus } from '../upstream/upstream-feed.js';
import { UpstreamFeedsService } from '../upstream/upstream-feeds.service.js';

/** The ingestor's state for operators. */
export interface IngestStatus {
  readonly service: string;
  readonly version: string;
  readonly at: Date;
  readonly upstreams: readonly {
    readonly feed: UpstreamFeedStatus;
    readonly activity: SourceActivity;
  }[];
  readonly pushers: {
    readonly connections: number;
    readonly activity: SourceActivity;
  };
  readonly pendingPublishes: number;
}

/** `GET /ingest/status` [super_admin]: upstream connection states and rates. */
@Injectable()
export class StatusService {
  constructor(
    @InjectConfig() private readonly config: IngestorConfig,
    private readonly upstreams: UpstreamFeedsService,
    private readonly pushers: PusherGateway,
    private readonly ingest: IngestService,
    private readonly metrics: IngestMetrics,
  ) {}

  /** @throws {ForbiddenError} `403` unless the principal is a platform administrator */
  status(principal: Principal, now: Date = new Date()): IngestStatus {
    if (!principal.isPlatformAdmin) {
      throw new ForbiddenError(
        'The ingest status is restricted to platform administrators',
      );
    }
    return {
      service: this.config.SERVICE_NAME,
      version: this.config.SERVICE_VERSION,
      at: now,
      upstreams: this.upstreams.status().map((feed) => ({
        feed,
        activity: this.metrics.activityOf(feed.source, now),
      })),
      pushers: {
        connections: this.pushers.connectionCount(),
        activity: this.metrics.activityOf('pusher', now),
      },
      pendingPublishes: this.ingest.pendingPublishes(),
    };
  }
}
