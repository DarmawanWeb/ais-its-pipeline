import {
  AllowApiKey,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import {
  bboxOf,
  MmsiParam,
  resolveQueryTimeRange,
} from '@darmawanweb/ais-its-nest/http';
import { Controller, Get, Query, Res } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import {
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
  LATEST_MAX_MMSIS,
  PositionsService,
  TRACK_DEFAULT_RANGE_MS,
  TRACK_MAX_RANGE_MS,
} from './positions.service.js';

/**
 * Response header of `GET /ais/latest`: `true` when more vessels matched
 * than `limit`. Exposed to cross-origin browsers (`PROCESSOR_CORS`).
 */
export const TRUNCATED_HEADER = 'X-Truncated';

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
    description:
      'Newest first. When more vessels match than `limit`, the least recently seen are left out and the response carries `X-Truncated: true`: raise `limit` (≤ 50 000), narrow `bbox` or `since`. ' +
      `With \`mmsi\` (up to ${LATEST_MAX_MMSIS} MMSIs) it is a batch lookup of those vessels: the latest position of each one ever recorded (vessels without a position are omitted; \`since\` and \`bbox\` still filter when given).`,
  })
  @ApiOkResponse({
    type: [VesselLatestDto],
    headers: {
      [TRUNCATED_HEADER]: {
        description:
          '`true` when more vessels matched than `limit` (the least recently seen were left out), else `false`',
        schema: { type: 'string', enum: ['true', 'false'] },
      },
    },
  })
  async latest(
    @Query() query: LatestQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<VesselLatestDto[]> {
    const latest = await this.positions.latest({
      bbox: bboxOf(query),
      since: query.since === undefined ? undefined : new Date(query.since),
      mmsis: query.mmsi,
      limit: query.limit,
    });
    reply.header(TRUNCATED_HEADER, String(latest.truncated));
    return latest.vessels.map((position) => new VesselLatestDto(position));
  }

  @Get('vessels/:mmsi/latest')
  @ApiOperation({ summary: 'Latest position of a vessel' })
  @ApiOkResponse({ type: VesselLatestDto })
  @ApiNotFoundResponse({ description: 'AIS_POSITION_NOT_FOUND' })
  async vesselLatest(@MmsiParam() mmsi: number): Promise<VesselLatestDto> {
    return new VesselLatestDto(await this.positions.latestOf(mmsi));
  }

  @Get('vessels/:mmsi/track')
  @ApiOperation({
    summary:
      'Track of a vessel (raw ≤ 7 days, 1m ≤ 90 days; default the last 24 h)',
  })
  @ApiOkResponse({ type: TrackDto })
  async track(
    @MmsiParam() mmsi: number,
    @Query() query: TrackQueryDto,
  ): Promise<TrackDto> {
    const { from, to } = resolveQueryTimeRange(query, {
      defaultDurationMs: TRACK_DEFAULT_RANGE_MS,
      maxDurationMs: TRACK_MAX_RANGE_MS[query.resolution],
    });
    return new TrackDto(
      await this.positions.track({
        mmsi,
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
      'Tracks of two vessels over the same range (legacy /ais/routes/:mmsi1/:mmsi2; raw ≤ 7 days, 1m ≤ 90 days; default the last 24 h)',
    description:
      'Both tracks use the same `resolution` and `simplify` as `GET /ais/vessels/{mmsi}/track` (e.g. `resolution=1m&simplify=25` for long encounters) and are each limited to 100 000 points (`truncated`, `remainingTo`).',
  })
  @ApiOkResponse({ type: PairTrackDto })
  async pairTrack(@Query() query: PairTrackQueryDto): Promise<PairTrackDto> {
    const { from, to } = resolveQueryTimeRange(query, {
      defaultDurationMs: TRACK_DEFAULT_RANGE_MS,
      maxDurationMs: TRACK_MAX_RANGE_MS[query.resolution],
    });
    return new PairTrackDto(
      from,
      to,
      await this.positions.pairTrack(query.mmsi1, query.mmsi2, {
        from,
        to,
        resolution: query.resolution,
        simplifyM: query.simplify,
      }),
    );
  }
}
