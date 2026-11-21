import { Module } from '@nestjs/common';

import { PositionsController } from './positions.controller.js';
import { PositionsRepository } from './positions.repository.js';
import { PositionsService } from './positions.service.js';

/** `GET /api/v2/ais/latest`, `…/vessels/:mmsi/{latest,track}`, `…/pairs/track`. */
@Module({
  controllers: [PositionsController],
  providers: [PositionsService, PositionsRepository],
})
export class PositionsModule {}
