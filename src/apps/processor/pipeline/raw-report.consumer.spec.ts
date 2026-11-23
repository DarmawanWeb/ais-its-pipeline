import { DEFAULT_PINNED_TTL_MS } from '@darmawanweb/ais-its-nest/nats';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PositionPipelineService } from './position-pipeline.service.js';
import {
  PROCESSOR_PINNED_TTL_MS,
  RawReportConsumer,
} from './raw-report.consumer.js';

describe('RawReportConsumer', () => {
  it('uses the kit default pin TTL (30 s): the kit keeps an idle instance pinned', () => {
    expect(PROCESSOR_PINNED_TTL_MS).toBe(DEFAULT_PINNED_TTL_MS);
    expect(PROCESSOR_PINNED_TTL_MS).toBe(30_000);
  });

  it('drops the in-memory vessel states when this instance becomes the active processor', () => {
    const log = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const pipeline = { resetVesselStates: vi.fn(() => 42) };
    const consumer = new RawReportConsumer(
      pipeline as unknown as PositionPipelineService,
    );

    consumer.onConsumerActivated({
      consumer: 'ais-processor',
      stream: 'AIS_RAW',
      pinId: 'pin-2',
      previous: 'pin-1',
      reason: 'pinned',
    });

    expect(pipeline.resetVesselStates).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      'ais-processor is active (pin pin-2, previously pin-1): dropped 42 cached vessel state(s)',
    );
    log.mockRestore();
  });
});
