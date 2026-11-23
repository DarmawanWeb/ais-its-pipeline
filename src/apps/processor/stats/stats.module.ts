import { Module } from '@nestjs/common';

import { StatsController } from './stats.controller.js';
import { StatsRepository } from './stats.repository.js';
import { StatsService } from './stats.service.js';
import { TrafficSampler } from './traffic-sampler.js';

/** `GET /api/v2/ais/stats` and its sampled history `GET /api/v2/ais/stats/series`. */
@Module({
  controllers: [StatsController],
  providers: [StatsService, StatsRepository, TrafficSampler],
})
export class StatsModule {}
