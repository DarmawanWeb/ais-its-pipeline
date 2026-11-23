import { setTimeout as sleep } from 'node:timers/promises';

import { EventConsumers, NatsClient } from '@darmawanweb/ais-its-nest/nats';
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

/**
 * Longer than two pin TTLs (2 × 30 s): with kit 0.2 (pull expiry = TTL) a
 * 30 s TTL unpinned an idle instance here; kit 0.3 pulls every TTL / 3.
 */
const IDLE_MS = 75_000;

/** The pin TTL of 0.1.0 (kit 0.2 unpinned an idle instance with 30 s) [ms]. */
const LEGACY_PINNED_TTL_MS = 90_000;

/** NATS durations are nanoseconds. */
const NS_PER_MS = 1_000_000;

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
 * the pin survives idle periods, a start reconciles the shared durable's pin
 * TTL (the 0.1.0 → 0.2.0 rolling update), and a graceful stop hands it over
 * to a standby at once instead of after the pin TTL (the kit releases the
 * pin on stop); the standby drops its in-memory vessel states when it
 * activates.
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
    'a start puts the shared durable back to the 30 s pin TTL that a 0.1.0 start set to 90 s (rolling update)',
    async () => {
      const [active] = processors;
      if (active === undefined) throw new Error('no processor');
      const name = `${prefix}${RAW_REPORT_CONSUMER}`;
      const { manager } = await ingestor.app.get(NatsClient).ready();
      const pinTtl = async () =>
        (await manager.consumers.info('AIS_RAW', name)).config.priority_timeout;
      const { config } = await manager.consumers.info('AIS_RAW', name);
      expect(config.priority_timeout).toBe(PROCESSOR_PINNED_TTL_MS * NS_PER_MS);

      // What a 0.1.0 processor (kit 0.2 reconciles the priority settings too) does at its start.
      await manager.consumers.update('AIS_RAW', name, {
        priority_groups: config.priority_groups ?? [],
        ...(config.priority_policy === undefined
          ? {}
          : { priority_policy: config.priority_policy }),
        priority_timeout: LEGACY_PINNED_TTL_MS * NS_PER_MS,
      });
      expect(await pinTtl()).toBe(LEGACY_PINNED_TTL_MS * NS_PER_MS);

      // A 0.2.0 start updates the durable in place for every instance.
      const upgraded = await startProcessor(auth, databaseUrl, {
        NATS_DURABLE_PREFIX: prefix,
      });
      try {
        expect(await pinTtl()).toBe(PROCESSOR_PINNED_TTL_MS * NS_PER_MS);
      } finally {
        await upgraded.app.close();
      }
      // The first instance is still (or again) the active one and records at once.
      await waitFor(() => consumerOf(active).health().state === 'active', {
        timeoutMs: PROCESSOR_PINNED_TTL_MS + 10_000,
      });
      expect(await recordLatency(active, 525006004)).toBeLessThan(5000);
    },
    PROCESSOR_PINNED_TTL_MS + 60_000,
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

      // Not pinned yet: `starting` until the server pins it.
      expect(consumerOf(standby).health().state).not.toBe('active');
      await active.app.close();
      processors.shift();
      const latency = await recordLatency(standby, 525006003);
      process.stdout.write(`handover latency: ${latency} ms\n`);
      // Without the released pin the standby would wait for the TTL (30 s).
      expect(latency).toBeLessThan(10_000);
      expect(consumerOf(standby).health()).toMatchObject({
        standby: false,
        state: 'active',
      });
      // The activation hook ran before the first report of the new pin.
      const metrics = (await standby.app.inject({ url: '/metrics' })).body;
      expect(metrics).toMatch(
        /aisits_events_consumer_activations_total\{consumer="[^"]*ais-processor"\} [1-9]/,
      );
    },
    PROCESSOR_PINNED_TTL_MS + 60_000,
  );
});
