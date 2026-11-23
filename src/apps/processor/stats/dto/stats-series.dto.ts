import { TimeRangeQueryDto } from '@darmawanweb/ais-its-nest/http';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import {
  type FeedTraffic,
  STATS_BUCKETS,
  type StatsBucket,
  type TrafficPoint,
  type TrafficSeries,
} from '../stats.service.js';

/** `GET /ais/stats/series?from&to&bucket`. */
export class StatsSeriesQueryDto extends TimeRangeQueryDto {
  @ApiPropertyOptional({
    enum: STATS_BUCKETS,
    default: '1m',
    description:
      'Bucket size (UTC-aligned): 1m — range ≤ 24 h, default the last hour; 5m — ≤ 7 days, default the last 24 h; 1h — ≤ 90 days, default the last 7 days',
  })
  @IsOptional()
  @IsIn(STATS_BUCKETS)
  readonly bucket: StatsBucket = '1m';
}

/** Counters of one feed in a bucket. */
export class FeedTrafficDto {
  @ApiProperty({
    description:
      'Positions recorded from this feed with a position time in the bucket (counted when each minute was sampled)',
    example: 812,
  })
  readonly messages: number;

  @ApiProperty({
    description:
      'Vessels whose latest position came from this feed within the active window, at the end of the bucket',
    example: 640,
  })
  readonly activeVessels: number;

  constructor(traffic: FeedTraffic) {
    this.messages = traffic.messages;
    this.activeVessels = traffic.activeVessels;
  }
}

/** Counters per feed. */
export class TrafficBySourceDto {
  @ApiProperty({ type: FeedTrafficDto })
  readonly primary: FeedTrafficDto;

  @ApiProperty({ type: FeedTrafficDto })
  readonly batam: FeedTrafficDto;

  @ApiProperty({ type: FeedTrafficDto })
  readonly pusher: FeedTrafficDto;

  constructor(bySource: TrafficPoint['bySource']) {
    this.primary = new FeedTrafficDto(bySource.primary);
    this.batam = new FeedTrafficDto(bySource.batam);
    this.pusher = new FeedTrafficDto(bySource.pusher);
  }
}

/** A bucket of the series. */
export class TrafficPointDto {
  @ApiProperty({ format: 'date-time', description: 'Start of the bucket' })
  readonly at: string;

  @ApiProperty({
    description:
      'Minutes of the bucket that were sampled (fewer than `bucketMinutes`: no processor ran for the others, or the bucket is still running)',
    example: 5,
  })
  readonly samples: number;

  @ApiProperty({
    description:
      'Positions recorded with a position time in the bucket, all feeds (divide by `samples` for the rate per minute)',
    example: 4060,
  })
  readonly messages: number;

  @ApiProperty({
    description:
      'Vessels with a latest position within the active window at the end of the bucket (its last sampled minute): `activeVessels` of GET /ais/stats at that time',
    example: 1234,
  })
  readonly activeVessels: number;

  @ApiProperty({ type: TrafficBySourceDto })
  readonly bySource: TrafficBySourceDto;

  constructor(point: TrafficPoint) {
    this.at = point.at.toISOString();
    this.samples = point.samples;
    this.messages = point.messages;
    this.activeVessels = point.activeVessels;
    this.bySource = new TrafficBySourceDto(point.bySource);
  }
}

/** `GET /api/v2/ais/stats/series`: the sampled history of GET /ais/stats. */
export class TrafficSeriesDto {
  @ApiProperty({
    format: 'date-time',
    description: 'Start of the first bucket (`from` floored to the bucket)',
  })
  readonly from: string;

  @ApiProperty({ format: 'date-time', description: 'End of the range' })
  readonly to: string;

  @ApiProperty({ enum: STATS_BUCKETS })
  readonly bucket: StatsBucket;

  @ApiProperty({ description: 'Minutes per bucket', example: 5 })
  readonly bucketMinutes: number;

  @ApiProperty({ example: 10 })
  readonly activeWindowMinutes: number;

  @ApiProperty({
    type: [TrafficPointDto],
    description:
      'Buckets with at least one sampled minute, in time order; a missing bucket is a gap (no processor ran). History starts with the first processor of version 0.2.0.',
  })
  readonly points: TrafficPointDto[];

  constructor(series: TrafficSeries) {
    this.from = series.from.toISOString();
    this.to = series.to.toISOString();
    this.bucket = series.bucket;
    this.bucketMinutes = series.bucketMinutes;
    this.activeWindowMinutes = series.activeWindowMinutes;
    this.points = series.points.map((point) => new TrafficPointDto(point));
  }
}
