import { InjectConfig } from '@darmawanweb/ais-its-nest';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import type { IngestorConfig } from '../config.js';
import { IngestMetrics } from '../ingest/ingest.metrics.js';
import { IngestService } from '../ingest/ingest.service.js';
import {
  UpstreamFeed,
  type UpstreamFeedStatus,
  type UpstreamSource,
} from './upstream-feed.js';

/** Feeds in a stable order, with the variable that enables each. */
const UPSTREAMS: readonly {
  readonly source: UpstreamSource;
  readonly url: (config: IngestorConfig) => string | undefined;
}[] = [
  { source: 'primary', url: (config) => config.AIS_PRIMARY_URL },
  { source: 'batam', url: (config) => config.AIS_BATAM_URL },
];

/**
 * Connects the configured upstream feeds once the application is up (NATS
 * connected, streams ensured) and closes them first on shutdown, before
 * NATS drains. A feed whose URL is empty is disabled.
 */
@Injectable()
export class UpstreamFeedsService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('UpstreamFeeds');
  private readonly feeds = new Map<UpstreamSource, UpstreamFeed>();

  constructor(
    @InjectConfig() private readonly config: IngestorConfig,
    private readonly ingest: IngestService,
    private readonly metrics: IngestMetrics,
  ) {}

  onApplicationBootstrap(): void {
    for (const { source, url } of UPSTREAMS) {
      const target = url(this.config);
      if (target === undefined) {
        this.logger.log(`Upstream ${source} disabled (no URL configured)`);
        continue;
      }
      const feed = new UpstreamFeed({
        source,
        url: target,
        token: this.config.AIS_UPSTREAM_TOKEN,
        reconnectMinMs: this.config.AIS_UPSTREAM_RECONNECT_MIN_MS,
        reconnectMaxMs: Math.max(
          this.config.AIS_UPSTREAM_RECONNECT_MIN_MS,
          this.config.AIS_UPSTREAM_RECONNECT_MAX_MS,
        ),
        onMessage: (message, receivedAt) => {
          this.ingest.ingestStreamed(message, source, receivedAt);
        },
        onConnectionChange: (connected) => {
          this.metrics.instruments.upstreamConnected.set(
            { source },
            connected ? 1 : 0,
          );
        },
        onReconnectAttempt: () => {
          this.metrics.instruments.upstreamReconnects.inc({ source });
        },
        logger: this.logger,
      });
      this.feeds.set(source, feed);
      this.metrics.instruments.upstreamConnected.set({ source }, 0);
      feed.start();
    }
  }

  beforeApplicationShutdown(): void {
    for (const feed of this.feeds.values()) feed.stop();
  }

  /** Every feed, disabled ones included. */
  status(): UpstreamFeedStatus[] {
    return UPSTREAMS.map(
      ({ source }) =>
        this.feeds.get(source)?.status() ?? {
          source,
          endpoint: null,
          state: 'disabled',
          connectedSince: null,
          lastDisconnectedAt: null,
          lastError: null,
          reconnectAttempts: 0,
        },
    );
  }
}
