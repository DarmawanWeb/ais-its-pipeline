import {
  CurrentPrincipal,
  type Principal,
} from '@darmawanweb/ais-its-nest/auth';
import { Controller, Get } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { IngestStatusDto } from './dto/ingest-status.dto.js';
import { StatusService } from './status.service.js';

/** `GET /api/v2/ingest/status` [super_admin]. */
@ApiTags('ingest')
@Controller('ingest/status')
export class StatusController {
  constructor(private readonly status: StatusService) {}

  @Get()
  @ApiOperation({
    summary:
      'Upstream connection states, pusher connections and rates (platform administrators)',
  })
  @ApiOkResponse({ type: IngestStatusDto })
  @ApiForbiddenResponse({ description: 'Not a platform administrator' })
  describe(@CurrentPrincipal() principal: Principal): IngestStatusDto {
    return new IngestStatusDto(this.status.status(principal));
  }
}
