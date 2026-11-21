import { Module } from '@nestjs/common';

import { FleetProjection } from './fleet.projection.js';
import { VesselRefsRepository } from './vessel-refs.repository.js';

/** FLEET projection (`ais-processor-fleet` → `ais.vessel_refs`). */
@Module({
  providers: [FleetProjection, VesselRefsRepository],
})
export class FleetModule {}
