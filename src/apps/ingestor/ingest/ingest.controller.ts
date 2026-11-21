import {
  AllowApiKey,
  CurrentPrincipal,
  type Principal,
} from '@darmawanweb/ais-its-nest/auth';
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiExtraModels,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';

import {
  LegacyAisMessageDto,
  NormalizedAisMessageDto,
} from './dto/ais-message.dto.js';
import { IngestResultDto } from './dto/ingest-result.dto.js';
import { IngestService, MAX_INGEST_BATCH } from './ingest.service.js';

const MESSAGE_SCHEMA = {
  oneOf: [
    { $ref: getSchemaPath(LegacyAisMessageDto) },
    { $ref: getSchemaPath(NormalizedAisMessageDto) },
  ],
};

/** `POST /api/v2/ingest/ais`: AIS reports from machines (spec §13.2). */
@ApiTags('ingest')
@ApiExtraModels(LegacyAisMessageDto, NormalizedAisMessageDto)
@Controller('ingest/ais')
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @AllowApiKey('ais:ingest')
  @ApiOperation({
    summary: 'Ingest AIS reports (one message or an array of ≤ 1000)',
    description:
      'Legacy `TimestampedAisMessage` or the normalized format. Each message is validated on its own: ' +
      'valid ones are published to AIS_RAW (source `pusher`, deduplicated by `<mmsi>:<positionTime>:<source>`), ' +
      'invalid ones are listed in `errors`. API keys need the `ais:ingest` scope; users must be platform administrators.',
  })
  @ApiBody({
    schema: {
      oneOf: [
        MESSAGE_SCHEMA,
        { type: 'array', maxItems: MAX_INGEST_BATCH, items: MESSAGE_SCHEMA },
      ],
    },
  })
  @ApiAcceptedResponse({ type: IngestResultDto })
  async ingestReports(
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ): Promise<IngestResultDto> {
    return new IngestResultDto(await this.ingest.ingestPushed(body, principal));
  }
}
