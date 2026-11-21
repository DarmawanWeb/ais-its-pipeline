import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import { EventPublisher } from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';

import { positionEventId } from '../../../shared/domain/event-id.js';
import {
  type RecordedPosition,
  toPositionRecorded,
} from './recorded-position.js';

/**
 * Publishes `ais.position.recorded.v1` to `ais.position.v1.<mmsi % 16>.<mmsi>`
 * (stream AIS_POSITION). The envelope id — and with it `Nats-Msg-Id` — is
 * derived from (mmsi, time), so a re-published position is dropped by
 * JetStream within 2 minutes and keeps its id for consumers after that.
 */
@Injectable()
export class PositionEventsPublisher {
  constructor(private readonly events: EventPublisher) {}

  async publish(
    position: RecordedPosition,
    previous: RecordedPosition | null,
  ): Promise<void> {
    await this.events.publishEvent(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      toPositionRecorded(position, previous),
      { id: positionEventId(position.mmsi, position.time) },
    );
  }
}
