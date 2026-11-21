import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import type { AisRawReceivedV1 } from '@darmawanweb/ais-its-contracts/events';
import { EventPublisher } from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';

import { rawReportMessageId } from '../../../shared/domain/normalize.js';

/** JetStream's verdict on a published report. */
export type PublishVerdict = 'stored' | 'duplicate';

/**
 * Publishes normalized reports as `ais.raw.received.v1` to `ais.raw.v1.<source>`
 * (stream `AIS_RAW`) with `Nats-Msg-Id = <mmsi>:<positionTime>:<source>`,
 * so a report re-sent within the 2-minute window is stored once.
 */
@Injectable()
export class RawReportPublisher {
  constructor(private readonly events: EventPublisher) {}

  /** Publishes one report and resolves with JetStream's verdict. */
  async publish(report: AisRawReceivedV1): Promise<PublishVerdict> {
    const { ack } = await this.events.publishEvent(
      EVENT_TYPES.AIS_RAW_RECEIVED,
      report,
      { msgId: rawReportMessageId(report) },
    );
    return ack.duplicate ? 'duplicate' : 'stored';
  }

  /**
   * Publishes reports (at most 64 in flight, in order) and resolves with the
   * verdicts in input order; rejects with the first failure.
   */
  async publishMany(
    reports: readonly AisRawReceivedV1[],
  ): Promise<PublishVerdict[]> {
    const acks = await this.events.publishMany(
      reports.map((report) => ({
        type: EVENT_TYPES.AIS_RAW_RECEIVED,
        data: report,
        options: { msgId: rawReportMessageId(report) },
      })),
    );
    return acks.map((ack) => (ack.duplicate ? 'duplicate' : 'stored'));
  }
}
