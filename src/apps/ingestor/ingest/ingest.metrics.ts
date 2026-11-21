import {
  AIS_SOURCES,
  type AisSource,
} from '@darmawanweb/ais-its-contracts/domain';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { Injectable } from '@nestjs/common';

import { RateWindow } from './rate-window.js';

/** What happened to a received report (`aisits_ais_messages_total{outcome}`). */
export type IngestOutcome =
  | 'published'
  | 'duplicate'
  | 'rejected'
  | 'failed'
  | 'dropped'
  | 'rate_limited';

/** Counters of one feed since the process started. */
export interface SourceActivity {
  readonly source: AisSource;
  /** Reports received (every outcome). */
  readonly received: number;
  readonly outcomes: Readonly<Record<IngestOutcome, number>>;
  /** Reports received in the last 60 s. */
  readonly receivedLastMinute: number;
  readonly lastReceivedAt: Date | null;
}

interface MutableActivity {
  received: number;
  outcomes: Record<IngestOutcome, number>;
  readonly window: RateWindow;
  lastReceivedAt: Date | null;
}

function instruments(metrics: MetricsService) {
  return {
    messages: metrics.counter({
      name: 'ais_messages_total',
      help: 'AIS reports received by the ingestor, by feed and outcome',
      labelNames: ['source', 'outcome'],
    }),
    rejections: metrics.counter({
      name: 'ais_rejections_total',
      help: 'AIS reports rejected by validation, by feed and reason',
      labelNames: ['source', 'code'],
    }),
    pendingPublishes: metrics.gauge({
      name: 'ais_publish_pending',
      help: 'Upstream reports waiting for their JetStream publish ack',
    }),
    upstreamConnected: metrics.gauge({
      name: 'ais_upstream_connected',
      help: '1 while the upstream socket.io feed is connected',
      labelNames: ['source'],
    }),
    upstreamReconnects: metrics.counter({
      name: 'ais_upstream_reconnects_total',
      help: 'Reconnection attempts of the upstream socket.io feeds',
      labelNames: ['source'],
    }),
    pusherConnections: metrics.gauge({
      name: 'ais_pusher_connections',
      help: 'Open socket.io pusher connections',
    }),
  };
}

/**
 * Domain metrics of the ingestor (spec §10, §13.2) and the in-memory
 * per-feed activity behind `GET /ingest/status`.
 */
@Injectable()
export class IngestMetrics {
  readonly instruments: ReturnType<typeof instruments>;
  private readonly activity = new Map<AisSource, MutableActivity>();

  constructor(metrics: MetricsService) {
    this.instruments = instruments(metrics);
    for (const source of AIS_SOURCES) {
      this.activity.set(source, {
        received: 0,
        outcomes: emptyOutcomes(),
        window: new RateWindow(),
        lastReceivedAt: null,
      });
    }
  }

  /** Counts `count` reports of `source` received at `now` that ended with `outcome`. */
  count(
    source: AisSource,
    outcome: IngestOutcome,
    count = 1,
    now = new Date(),
  ): void {
    if (count <= 0) return;
    this.instruments.messages.inc({ source, outcome }, count);
    const activity = this.activity.get(source);
    if (activity === undefined) return;
    activity.received += count;
    activity.outcomes[outcome] += count;
    activity.window.add(now.getTime(), count);
    activity.lastReceivedAt = now;
  }

  /** Counts one rejection reason (the report itself is counted by {@link count}). */
  rejected(source: AisSource, code: string): void {
    this.instruments.rejections.inc({ source, code });
  }

  /** Activity of a feed at `now`. */
  activityOf(source: AisSource, now = new Date()): SourceActivity {
    const activity = this.activity.get(source);
    return {
      source,
      received: activity?.received ?? 0,
      outcomes: { ...(activity?.outcomes ?? emptyOutcomes()) },
      receivedLastMinute: activity?.window.total(now.getTime()) ?? 0,
      lastReceivedAt: activity?.lastReceivedAt ?? null,
    };
  }
}

function emptyOutcomes(): Record<IngestOutcome, number> {
  return {
    published: 0,
    duplicate: 0,
    rejected: 0,
    failed: 0,
    dropped: 0,
    rate_limited: 0,
  };
}
