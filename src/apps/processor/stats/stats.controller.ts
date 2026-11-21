import {
  AllowApiKey,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AisStatsDto } from './dto/stats.dto.js';
import { StatsService } from './stats.service.js';

/** `GET /api/v2/ais/stats` [ais:read; API keys with `ais:read`]. */
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
}
