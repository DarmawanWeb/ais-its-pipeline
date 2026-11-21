import { AIS_SOURCES } from '@darmawanweb/ais-its-contracts/domain';
import { ApiProperty } from '@nestjs/swagger';

import type { SourceActivity } from '../../ingest/ingest.metrics.js';
import type { UpstreamFeedStatus } from '../../upstream/upstream-feed.js';
import type { IngestStatus } from '../status.service.js';

/** Reports received from a feed since the process started. */
export class SourceActivityDto {
  @ApiProperty({ enum: AIS_SOURCES })
  readonly source: string;

  @ApiProperty({ description: 'Reports received (every outcome)' })
  readonly received: number;

  @ApiProperty({ description: 'Stored in AIS_RAW' })
  readonly published: number;

  @ApiProperty({
    description: 'Re-sent reports JetStream dropped as duplicates',
  })
  readonly duplicates: number;

  @ApiProperty({ description: 'Invalid reports' })
  readonly rejected: number;

  @ApiProperty({ description: 'Publishes that failed' })
  readonly failed: number;

  @ApiProperty({
    description:
      'Upstream reports dropped while too many publishes were pending',
  })
  readonly dropped: number;

  @ApiProperty({
    description: 'Pushed reports refused by the per-connection rate limit',
  })
  readonly rateLimited: number;

  @ApiProperty({ description: 'Rate: reports received in the last 60 s' })
  readonly receivedLastMinute: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly lastReceivedAt: string | null;

  constructor(activity: SourceActivity) {
    this.source = activity.source;
    this.received = activity.received;
    this.published = activity.outcomes.published;
    this.duplicates = activity.outcomes.duplicate;
    this.rejected = activity.outcomes.rejected;
    this.failed = activity.outcomes.failed;
    this.dropped = activity.outcomes.dropped;
    this.rateLimited = activity.outcomes.rate_limited;
    this.receivedLastMinute = activity.receivedLastMinute;
    this.lastReceivedAt = activity.lastReceivedAt?.toISOString() ?? null;
  }
}

/** An upstream socket.io feed. */
export class UpstreamStatusDto {
  @ApiProperty({ enum: ['primary', 'batam'] })
  readonly source: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Server endpoint (no credentials), null when disabled',
    example: 'wss://ais.example.org',
  })
  readonly endpoint: string | null;

  @ApiProperty({
    enum: ['disabled', 'connecting', 'connected', 'disconnected', 'stopped'],
  })
  readonly state: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly connectedSince: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly lastDisconnectedAt: string | null;

  @ApiProperty({ type: String, nullable: true })
  readonly lastError: string | null;

  @ApiProperty({
    description: 'Reconnection attempts since the last successful connection',
  })
  readonly reconnectAttempts: number;

  @ApiProperty({ type: SourceActivityDto })
  readonly activity: SourceActivityDto;

  constructor(feed: UpstreamFeedStatus, activity: SourceActivity) {
    this.source = feed.source;
    this.endpoint = feed.endpoint;
    this.state = feed.state;
    this.connectedSince = feed.connectedSince?.toISOString() ?? null;
    this.lastDisconnectedAt = feed.lastDisconnectedAt?.toISOString() ?? null;
    this.lastError = feed.lastError;
    this.reconnectAttempts = feed.reconnectAttempts;
    this.activity = new SourceActivityDto(activity);
  }
}

/** Pushers (socket.io `ais:data` and `POST /ingest/ais`, source `pusher`). */
export class PushersStatusDto {
  @ApiProperty({ description: 'Open socket.io pusher connections' })
  readonly connections: number;

  @ApiProperty({ type: SourceActivityDto })
  readonly activity: SourceActivityDto;

  constructor(connections: number, activity: SourceActivity) {
    this.connections = connections;
    this.activity = new SourceActivityDto(activity);
  }
}

/** `GET /api/v2/ingest/status`. */
export class IngestStatusDto {
  @ApiProperty({ example: 'ais-ingestor' })
  readonly service: string;

  @ApiProperty({ example: '0.1.0' })
  readonly version: string;

  @ApiProperty({ format: 'date-time' })
  readonly at: string;

  @ApiProperty({ type: [UpstreamStatusDto] })
  readonly upstreams: UpstreamStatusDto[];

  @ApiProperty({ type: PushersStatusDto })
  readonly pushers: PushersStatusDto;

  @ApiProperty({
    description: 'Upstream reports waiting for their JetStream ack',
  })
  readonly pendingPublishes: number;

  constructor(status: IngestStatus) {
    this.service = status.service;
    this.version = status.version;
    this.at = status.at.toISOString();
    this.upstreams = status.upstreams.map(
      ({ feed, activity }) => new UpstreamStatusDto(feed, activity),
    );
    this.pushers = new PushersStatusDto(
      status.pushers.connections,
      status.pushers.activity,
    );
    this.pendingPublishes = status.pendingPublishes;
  }
}
