import { setTimeout as sleep } from 'node:timers/promises';

import { EventConsumers } from '@darmawanweb/ais-its-nest/nats';
import { uniqueName, waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PROCESSOR_PINNED_TTL_MS,
  RAW_REPORT_CONSUMER,
} from '../src/apps/processor/pipeline/raw-report.consumer.js';
import { normalizedMessage } from './support/messages.js';
import {
  purgeStreams,
  resetProcessorSchema,
  startIngestor,
  startProcessor,
  startTestAuth,
  type TestAuth,
  type TestIngestor,
  type TestProcessor,
} from './support/test-apps.js';

/** Longer than two pull expiries of the kit (2 × 30 s): a 30 s pin TTL unpinned an idle instance here. */
const IDLE_MS = 75_000;

function consumerOf(processor: TestProcessor) {
  const name = `${processor.config.NATS_DURABLE_PREFIX}${RAW_REPORT_CONSUMER}`;
  const runner = processor.app
    .get(EventConsumers)
    .running.find((candidate) => candidate.name === name);
  // Durable runners report their health (standby = another instance is pinned).
  if (runner === undefined || !('health' in runner))
    throw new Error(`${name} is not running`);
  return runner;
}

/**
 * The exclusive `ais-processor` consumer (one active instance, spec §13.2):
 * the pin survives idle periods, and a graceful stop hands it over to a
 * standby at once instead of after the pin TTL.
 */
describe('exclusive ais-processor consumer: idle pin and graceful handover', () => {
  let auth: TestAuth;
  let ingestor: TestIngestor;
  let databaseUrl: string;
  let ingestKey: string;
  /** Both processors share this prefix: the same durable consumer. */
  const prefix = uniqueName('x');
  const processors: TestProcessor[] = [];

  /** Ingests one report and resolves with the time until its latest row exists [ms]. */
  async function recordLatency(
    processor: TestProcessor,
    mmsi: number,
  ): Promise<number> {
    const started = Date.now();
    const response = await ingestor.app.inject({
      method: 'POST',
      url: '/api/v2/ingest/ais',
      headers: { 'x-api-key': ingestKey },
      payload: normalizedMessage({
        mmsi,
        lat: -7.25,
        lon: 112.8,
        sog: 5,
        cog: 10,
        hdg: 11,
        timestamp: new Date(started - 1000),
      }),
    });
    expect(response.statusCode).toBe(202);
    await waitFor(
      async () => {
        const { rows } = await processor.pool.query(
          'SELECT 1 FROM vessel_latest WHERE mmsi = $1',
          [mmsi],
        );
        return rows.length > 0;
      },
      { timeoutMs: PROCESSOR_PINNED_TTL_MS + 30_000, intervalMs: 50 },
    );
    return Date.now() - started;
  }

  beforeAll(async () => {
    auth = await startTestAuth();
    ingestKey = auth.apiKey(['ais:ingest']);
    ingestor = await startIngestor(auth);
    await purgeStreams(ingestor.app, ['AIS_RAW', 'AIS_POSITION']);
    databaseUrl = await resetProcessorSchema();
    processors.push(
      await startProcessor(auth, databaseUrl, { NATS_DURABLE_PREFIX: prefix }),
    );
  });

  afterAll(async () => {
    for (const processor of processors) await processor.app.close();
    await ingestor.app.close();
    await auth.close();
  });

  it(
    'keeps the active instance pinned through an idle period: the next report is recorded at once',
    async () => {
      const [active] = processors;
      if (active === undefined) throw new Error('no processor');
      expect(await recordLatency(active, 525006001)).toBeLessThan(5000);

      await sleep(IDLE_MS);
      const latency = await recordLatency(active, 525006002);
      process.stdout.write(`latency after ${IDLE_MS} ms idle: ${latency} ms\n`);
      expect(latency).toBeLessThan(5000);
      expect(consumerOf(active).health().standby).toBe(false);
    },
    IDLE_MS + 60_000,
  );

  it(
    'hands the consumer over to the standby at once when the active instance stops gracefully',
    async () => {
      const [active] = processors;
      if (active === undefined) throw new Error('no processor');
      const standby = await startProcessor(auth, databaseUrl, {
        NATS_DURABLE_PREFIX: prefix,
      });
      processors.push(standby);
      // Let the standby's pull request reach the server.
      await sleep(1000);

      await active.app.close();
      processors.shift();
      const latency = await recordLatency(standby, 525006003);
      process.stdout.write(`handover latency: ${latency} ms\n`);
      // Without the handover the standby waits for the pin TTL (90 s).
      expect(latency).toBeLessThan(10_000);
      expect(consumerOf(standby).health().standby).toBe(false);
    },
    PROCESSOR_PINNED_TTL_MS + 60_000,
  );
});
