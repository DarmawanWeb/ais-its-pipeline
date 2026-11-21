import { ApiProperty } from '@nestjs/swagger';

import type { AisStats, FeedStats } from '../stats.service.js';

/** Counts of one feed. */
export class FeedStatsDto {
  @ApiProperty({
    description:
      'Vessels whose latest position came from this feed in the active window',
  })
  readonly activeVessels: number;

  @ApiProperty({
    description: 'Positions recorded from this feed in the last minute',
  })
  readonly messagesLastMinute: number;

  constructor(stats: FeedStats) {
    this.activeVessels = stats.activeVessels;
    this.messagesLastMinute = stats.messagesLastMinute;
  }
}

/** Counts per feed. */
export class BySourceDto {
  @ApiProperty({ type: FeedStatsDto })
  readonly primary: FeedStatsDto;

  @ApiProperty({ type: FeedStatsDto })
  readonly batam: FeedStatsDto;

  @ApiProperty({ type: FeedStatsDto })
  readonly pusher: FeedStatsDto;

  constructor(bySource: AisStats['bySource']) {
    this.primary = new FeedStatsDto(bySource.primary);
    this.batam = new FeedStatsDto(bySource.batam);
    this.pusher = new FeedStatsDto(bySource.pusher);
  }
}

/** `GET /api/v2/ais/stats`. */
export class AisStatsDto {
  @ApiProperty({
    description: 'Vessels with a position in the active window',
    example: 1234,
  })
  readonly activeVessels: number;

  @ApiProperty({
    description: 'Positions recorded in the last minute (by position time)',
    example: 812,
  })
  readonly messagesLastMinute: number;

  @ApiProperty({ type: BySourceDto })
  readonly bySource: BySourceDto;

  @ApiProperty({ example: 10 })
  readonly activeWindowMinutes: number;

  @ApiProperty({ format: 'date-time' })
  readonly at: string;

  constructor(stats: AisStats) {
    this.activeVessels = stats.activeVessels;
    this.messagesLastMinute = stats.messagesLastMinute;
    this.bySource = new BySourceDto(stats.bySource);
    this.activeWindowMinutes = stats.activeWindowMinutes;
    this.at = stats.at.toISOString();
  }
}
