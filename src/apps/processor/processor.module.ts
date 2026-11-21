import { AuthModule } from '@darmawanweb/ais-its-nest/auth';
import { DatabaseModule } from '@darmawanweb/ais-its-nest/db';
import { NatsModule } from '@darmawanweb/ais-its-nest/nats';
import { RedisModule } from '@darmawanweb/ais-its-nest/redis';
import { Module } from '@nestjs/common';

import { SERVICE } from '../../shared/service.js';
import * as schema from './db/schema.js';
import { FleetModule } from './fleet/fleet.module.js';
import { MethodologyModule } from './methodology/methodology.module.js';
import { PipelineModule } from './pipeline/pipeline.module.js';
import { PositionsModule } from './positions/positions.module.js';
import { StatsModule } from './stats/stats.module.js';

/**
 * Root module of the processor: AIS_RAW → schema `ais` + Valkey →
 * AIS_POSITION, the FLEET projection and the AIS query API.
 * `bootstrapService()` wraps it in the kit's platform root module.
 */
@Module({
  imports: [
    // pg pool + drizzle (search_path=ais,public); migrations on boot.
    DatabaseModule.forRoot({
      schema,
      migrationsDir: SERVICE.processor.migrationsDir,
    }),
    // The processor PRODUCES to AIS_POSITION; its consumers (ais-processor on
    // AIS_RAW, ais-processor-fleet on FLEET) never change those streams.
    NatsModule.forRoot({ streams: ['AIS_POSITION'] }),
    // Valkey: per-vessel last position (ais:last:<mmsi>).
    RedisModule.forRoot(),
    // Default-deny guard; API keys (scope ais:read) are introspected through AUTH_INTERNAL_URL.
    AuthModule.forRoot(),
    PipelineModule,
    FleetModule,
    PositionsModule,
    StatsModule,
    MethodologyModule,
  ],
})
export class ProcessorModule {}
