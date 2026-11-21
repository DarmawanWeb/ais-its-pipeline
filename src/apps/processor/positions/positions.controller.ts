import {
  AllowApiKey,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { bboxOf, resolveQueryTimeRange } from '@darmawanweb/ais-its-nest/http';
import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import {
  MmsiParamDto,
  LatestQueryDto,
  PairTrackQueryDto,
  TrackQueryDto,
} from './dto/positions-query.dto.js';
import {
  PairTrackDto,
  TrackDto,
  VesselLatestDto,
} from './dto/positions.dto.js';
import {
  PositionsService,
  TRACK_DEFAULT_RANGE_MS,
  TRACK_MAX_RANGE_MS,
} from './positions.service.js';

/**
 * AIS query API (spec §13.2): `ais:read` for users, API keys with the
 * `ais:read` scope. AIS data is shared across tenants (spec §8.5).
 */
@ApiTags('ais')
@RequirePermissions('ais:read')
@AllowApiKey('ais:read')
@Controller('ais')
export class PositionsController {
  constructor(private readonly positions: PositionsService) {}

  @Get('latest')
  @ApiOperation({
    summary: 'Latest position of every vessel (map initial state)',
  })
  @ApiOkResponse({ type: [VesselLatestDto] })
  async latest(@Query() query: LatestQueryDto): Promise<VesselLatestDto[]> {
    const latest = await this.positions.latest({
      bbox: bboxOf(query),
      since: query.since === undefined ? undefined : new Date(query.since),
      limit: query.limit,
    });
    return latest.map((position) => new VesselLatestDto(position));
  }

  @Get('vessels/:mmsi/latest')
  @ApiOperation({ summary: 'Latest position of a vessel' })
  @ApiOkResponse({ type: VesselLatestDto })
  @ApiNotFoundResponse({ description: 'AIS_POSITION_NOT_FOUND' })
  async vesselLatest(@Param() params: MmsiParamDto): Promise<VesselLatestDto> {
    return new VesselLatestDto(await this.positions.latestOf(params.mmsi));
  }

  @Get('vessels/:mmsi/track')
  @ApiOperation({
    summary:
      'Track of a vessel (raw ≤ 7 days, 1m ≤ 90 days; default the last 24 h)',
  })
  @ApiOkResponse({ type: TrackDto })
  async track(
    @Param() params: MmsiParamDto,
    @Query() query: TrackQueryDto,
  ): Promise<TrackDto> {
    const { from, to } = resolveQueryTimeRange(query, {
      defaultDurationMs: TRACK_DEFAULT_RANGE_MS,
      maxDurationMs: TRACK_MAX_RANGE_MS[query.resolution],
    });
    return new TrackDto(
      await this.positions.track({
        mmsi: params.mmsi,
        from,
        to,
        resolution: query.resolution,
        simplifyM: query.simplify,
      }),
    );
  }

  @Get('pairs/track')
  @ApiOperation({
    summary:
      'Raw tracks of two vessels over the same range (legacy /ais/routes/:mmsi1/:mmsi2)',
  })
  @ApiOkResponse({ type: PairTrackDto })
  async pairTrack(@Query() query: PairTrackQueryDto): Promise<PairTrackDto> {
    const { from, to } = resolveQueryTimeRange(query, {
      defaultDurationMs: TRACK_DEFAULT_RANGE_MS,
      maxDurationMs: TRACK_MAX_RANGE_MS.raw,
    });
    return new PairTrackDto(
      from,
      to,
      await this.positions.pairTrack(query.mmsi1, query.mmsi2, from, to),
    );
  }
}
