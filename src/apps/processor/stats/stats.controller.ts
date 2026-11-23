import {
  AllowApiKey,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { resolveQueryTimeRange } from '@darmawanweb/ais-its-nest/http';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  StatsSeriesQueryDto,
  TrafficSeriesDto,
} from './dto/stats-series.dto.js';
import { AisStatsDto } from './dto/stats.dto.js';
import {
  STATS_SERIES_DEFAULT_RANGE_MS,
  STATS_SERIES_MAX_RANGE_MS,
  StatsService,
} from './stats.service.js';

/**
 * `GET /api/v2/ais/stats` and `/stats/series` [ais:read; API keys with
 * `ais:read`]. AIS data is shared across tenants (spec §8.5).
 */
@ApiTags('ais')
@RequirePermissions('ais:read')
@AllowApiKey('ais:read')
@Controller('ais/stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  @ApiOperation({
    summary: 'Active vessels and recorded positions per minute, by feed',
  })
  @ApiOkResponse({ type: AisStatsDto })
  async describe(): Promise<AisStatsDto> {
    return new AisStatsDto(await this.stats.stats());
  }

  @Get('series')
  @ApiOperation({
    summary:
      'History of the statistics: recorded positions and active vessels per bucket, by feed',
    description:
      'The processor samples the counters of GET /ais/stats at the end of every minute; buckets of 5 minutes and 1 hour add up the positions of their minutes and report the active vessels of their last sampled minute. ' +
      'Buckets are UTC-aligned and labelled with their start; `from` is floored to the bucket. A bucket without any sampled minute is left out (a gap), and the bucket still running has `samples` < `bucketMinutes`.',
  })
  @ApiOkResponse({ type: TrafficSeriesDto })
  async series(@Query() query: StatsSeriesQueryDto): Promise<TrafficSeriesDto> {
    const { from, to } = resolveQueryTimeRange(query, {
      defaultDurationMs: STATS_SERIES_DEFAULT_RANGE_MS[query.bucket],
      maxDurationMs: STATS_SERIES_MAX_RANGE_MS[query.bucket],
    });
    return new TrafficSeriesDto(
      await this.stats.series({ from, to, bucket: query.bucket }),
    );
  }
}
