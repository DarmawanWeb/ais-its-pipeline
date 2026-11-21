import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import {
  type ConsumerEnvelope,
  EventHandler,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable, Logger } from '@nestjs/common';

import { VesselRefsRepository } from './vessel-refs.repository.js';

/**
 * Projection of the FLEET stream (durable `ais-processor-fleet`, spec §7.3)
 * into `ais.vessel_refs`: MMSI → vessel id, name and type code, used to
 * enrich the AIS responses. Idempotent: snapshots older than the stored one
 * are ignored.
 */
@Injectable()
export class FleetProjection {
  private readonly logger = new Logger(FleetProjection.name);

  constructor(private readonly refs: VesselRefsRepository) {}

  @EventHandler({ consumer: 'ais-processor-fleet' })
  async onVessel(
    event: ConsumerEnvelope<'ais-processor-fleet'>,
  ): Promise<void> {
    switch (event.type) {
      case EVENT_TYPES.FLEET_VESSEL_UPSERTED: {
        const vessel = event.data;
        const change = await this.refs.upsert({
          mmsi: vessel.mmsi,
          vesselId: vessel.id,
          name: vessel.name,
          typeCode: vessel.type.code,
          updatedAt: new Date(vessel.updatedAt),
        });
        if (change === 'stale')
          this.logger.debug(`Ignored a stale snapshot of vessel ${vessel.id}`);
        break;
      }
      case EVENT_TYPES.FLEET_VESSEL_DELETED:
        await this.refs.deleteByVesselId(event.data.id);
        break;
    }
  }
}
