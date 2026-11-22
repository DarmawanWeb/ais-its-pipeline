import {
  type AisRawReceivedV1,
  EVENT_TYPES,
  SUBJECT_FILTERS,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  legacyMessage,
  normalizedMessage,
  positionTimeOf,
} from './support/messages.js';
import {
  readEvents,
  startIngestor,
  startTestAuth,
  type TestAuth,
  type TestIngestor,
} from './support/test-apps.js';

const INGEST_URL = '/api/v2/ingest/ais';
const STATUS_URL = '/api/v2/ingest/status';

/** Raw reports of the pusher feed stored since `from`. */
async function pushedReports(
  ingestor: TestIngestor,
  from: Date,
): Promise<{ data: AisRawReceivedV1; msgId: string | null }[]> {
  const events = await readEvents(ingestor.app, {
    stream: 'AIS_RAW',
    filterSubjects: [subjects.aisRaw('pusher')],
    eventTypes: [EVENT_TYPES.AIS_RAW_RECEIVED],
    from,
  });
  return events.flatMap(({ event, msgId }) =>
    event.type === EVENT_TYPES.AIS_RAW_RECEIVED
      ? [{ data: event.data, msgId }]
      : [],
  );
}

describe('ingestor: POST /api/v2/ingest/ais and GET /api/v2/ingest/status', () => {
  let auth: TestAuth;
  let ingestor: TestIngestor;
  let ingestKey: string;
  let readKey: string;
  const startedAt = new Date();

  beforeAll(async () => {
    auth = await startTestAuth();
    ingestor = await startIngestor(auth);
    ingestKey = auth.apiKey(['ais:ingest'], 'pusher A');
    readKey = auth.apiKey(['ais:read'], 'reader');
  });

  afterAll(async () => {
    await ingestor.app.close();
    await auth.close();
  });

  it('is live and ready with NATS (no database), with metrics and its OpenAPI document', async () => {
    const ready = await ingestor.app.inject({ url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    const details = ready.json<{ details: Record<string, unknown> }>().details;
    expect(details).toHaveProperty('nats');
    expect(details).not.toHaveProperty('database');

    const document = (
      await ingestor.app.inject({ url: '/openapi.json' })
    ).json<{
      paths: Record<string, unknown>;
    }>();
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([INGEST_URL, STATUS_URL]),
    );
  });

  it('refuses anonymous callers, keys without ais:ingest and ordinary users', async () => {
    const message = normalizedMessage({
      mmsi: 525005141,
      lat: -8.75,
      lon: 116.06,
      timestamp: new Date(),
    });
    const anonymous = await ingestor.app.inject({
      method: 'POST',
      url: INGEST_URL,
      payload: message,
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['content-type']).toContain(
      'application/problem+json',
    );

    const wrongScope = await ingestor.app.inject({
      method: 'POST',
      url: INGEST_URL,
      headers: { 'x-api-key': readKey },
      payload: message,
    });
    expect(wrongScope.statusCode).toBe(403);
    expect(wrongScope.json()).toMatchObject({ code: 'INSUFFICIENT_SCOPE' });

    const viewer = await ingestor.app.inject({
      method: 'POST',
      url: INGEST_URL,
      headers: await auth.bearer({ roles: ['fleet_manager'] }),
      payload: message,
    });
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('normalizes a legacy message (position time = timestamp − utc) and publishes it with Nats-Msg-Id <mmsi>:<positionTime>:<source>', async () => {
    const fields = {
      mmsi: '525005141',
      lat: -8.747773333333333,
      lon: 116.05734,
      sog: 0.1,
      cog: 0,
      hdg: 511,
      navstatus: 0,
      utc: 24,
      timestamp: new Date(Date.now() - 60_000),
    };
    const response = await ingestor.app.inject({
      method: 'POST',
      url: INGEST_URL,
      headers: { 'x-api-key': ingestKey },
      payload: legacyMessage(fields),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: 1, rejected: 0, errors: [] });
    const positionTime = positionTimeOf(fields);
    const stored = (await pushedReports(ingestor, startedAt)).filter(
      ({ data }) => data.positionTime === positionTime,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.msgId).toBe(`525005141:${positionTime}:pusher`);
    expect(stored[0]?.data).toMatchObject({
      source: 'pusher',
      mmsi: 525005141,
      navstatus: 0,
      lat: -8.747773333333333,
      lon: 116.05734,
      sog: 0.1,
      cog: 0,
      hdg: 511,
      aisType: 1,
      receiverPort: 'COM3',
    });
  });

  it('accepts a mixed batch: valid reports are published, invalid ones listed with their index and code', async () => {
    const now = Date.now();
    const base = {
      mmsi: 525005142,
      lat: -7.15,
      lon: 112.9,
      timestamp: new Date(now - 30_000),
    };
    const batch = [
      normalizedMessage(base),
      legacyMessage({ ...base, lat: 91, timestamp: new Date(now - 29_000) }),
      normalizedMessage({
        ...base,
        lon: 181,
        timestamp: new Date(now - 28_000),
      }),
      normalizedMessage({ ...base, mmsi: 52500514 }),
      { ...normalizedMessage(base), sog: undefined },
      normalizedMessage({
        ...base,
        lat: -95,
        timestamp: new Date(now - 27_000),
      }),
      normalizedMessage({ ...base, timestamp: new Date(now - 26_000), utc: 6 }),
    ];

    const response = await ingestor.app.inject({
      method: 'POST',
      url: INGEST_URL,
      headers: { 'x-api-key': ingestKey },
      payload: batch,
    });

    expect(response.statusCode).toBe(202);
    const result = response.json<{
      accepted: number;
      rejected: number;
      errors: { index: number; code: string; field: string | null }[];
    }>();
    expect(result.accepted).toBe(2);
    expect(result.rejected).toBe(5);
    expect(result.errors).toEqual([
      expect.objectContaining({
        index: 1,
        code: 'POSITION_NOT_AVAILABLE',
        field: 'message.data.lat',
      }),
      expect.objectContaining({
        index: 2,
        code: 'POSITION_NOT_AVAILABLE',
        field: 'lon',
      }),
      expect.objectContaining({
        index: 3,
        code: 'INVALID_MMSI',
        field: 'mmsi',
      }),
      expect.objectContaining({
        index: 4,
        code: 'MISSING_FIELD',
        field: 'sog',
      }),
      expect.objectContaining({ index: 5, code: 'OUT_OF_RANGE', field: 'lat' }),
    ]);
    const stored = (await pushedReports(ingestor, startedAt)).filter(
      ({ data }) => data.mmsi === 525005142,
    );
    expect(stored.map(({ data }) => data.positionTime).sort()).toEqual(
      [
        new Date(now - 30_000).toISOString(),
        new Date(now - 32_000).toISOString(), // 26 s ago minus utc 6 s
      ].sort(),
    );
  });

  it('lists implausible position times per message instead of failing the batch (before 1970, negative years, epoch seconds)', async () => {
    const now = Date.now();
    const valid = normalizedMessage({
      mmsi: 525005148,
      lat: -7.15,
      lon: 112.9,
      timestamp: new Date(now - 5000),
    });
    const at = (mmsi: number, timestamp: string | number) => ({
      ...valid,
      mmsi,
      timestamp,
    });
    // The reviewer's batch: it used to answer 503 "retry" (unpublishable
    // report) after storing the plausible ones, and could never succeed.
    const response = await ingestor.app.inject({
      method: 'POST',
      url: INGEST_URL,
      headers: { 'x-api-key': ingestKey },
      payload: [
        at(525000001, '0001-01-01T00:00:00Z'),
        at(525000002, '1960-06-01T00:00:00Z'),
        at(525000003, '-000001-01-01T00:00:00Z'),
        at(525000004, 1700000000),
        valid,
      ],
    });

    expect(response.statusCode).toBe(202);
    expect(
      response.json<{
        accepted: number;
        rejected: number;
        errors: { index: number; code: string; field: string | null }[];
      }>(),
    ).toEqual({
      accepted: 1,
      rejected: 4,
      errors: [
        expect.objectContaining({ index: 0, code: 'INVALID_TIMESTAMP' }),
        expect.objectContaining({ index: 1, code: 'INVALID_TIMESTAMP' }),
        expect.objectContaining({ index: 2, code: 'INVALID_TIMESTAMP' }),
        expect.objectContaining({
          index: 3,
          code: 'STALE_TIMESTAMP',
          field: 'timestamp',
        }),
      ],
    });
    const stored = (await pushedReports(ingestor, startedAt)).filter(
      ({ data }) => data.mmsi >= 525000001 && data.mmsi <= 525000004,
    );
    expect(stored).toEqual([]);
  });

  it('is idempotent: a re-sent batch is accepted and stored once', async () => {
    const message = normalizedMessage({
      mmsi: 525005143,
      lat: -6.5,
      lon: 112.5,
      timestamp: new Date(Date.now() - 10_000),
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await ingestor.app.inject({
        method: 'POST',
        url: INGEST_URL,
        headers: { 'x-api-key': ingestKey },
        payload: [message, message],
      });
      expect(response.json()).toMatchObject({ accepted: 2, rejected: 0 });
    }
    const stored = (await pushedReports(ingestor, startedAt)).filter(
      ({ data }) => data.mmsi === 525005143,
    );
    expect(stored).toHaveLength(1);
  });

  it('rejects a batch of more than 1000 messages and payloads that are not messages', async () => {
    const message = normalizedMessage({
      mmsi: 525005144,
      lat: -6.5,
      lon: 112.5,
      timestamp: new Date(),
    });
    const tooLarge = await ingestor.app.inject({
      method: 'POST',
      url: INGEST_URL,
      headers: { 'x-api-key': ingestKey },
      payload: Array.from({ length: 1001 }, () => message),
    });
    expect(tooLarge.statusCode).toBe(400);
    expect(tooLarge.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const notAMessage = await ingestor.app.inject({
      method: 'POST',
      url: INGEST_URL,
      headers: { 'x-api-key': ingestKey, 'content-type': 'application/json' },
      payload: '42',
    });
    expect(notAMessage.statusCode).toBe(400);
  });

  it('lets platform administrators ingest for manual testing', async () => {
    const response = await ingestor.app.inject({
      method: 'POST',
      url: INGEST_URL,
      headers: await auth.bearer({ roles: ['super_admin'] }),
      payload: normalizedMessage({
        mmsi: 525005145,
        lat: -6.5,
        lon: 112.5,
        timestamp: new Date(Date.now() - 5_000),
      }),
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: 1 });
  });

  it('reports feeds and rates to platform administrators only', async () => {
    const viewer = await ingestor.app.inject({
      url: STATUS_URL,
      headers: await auth.bearer({ roles: ['org_admin'] }),
    });
    expect(viewer.statusCode).toBe(403);

    const response = await ingestor.app.inject({
      url: STATUS_URL,
      headers: await auth.bearer({ roles: ['super_admin'] }),
    });
    expect(response.statusCode).toBe(200);
    const status = response.json<{
      upstreams: { source: string; state: string }[];
      pushers: {
        connections: number;
        activity: { published: number; rejected: number; duplicates: number };
      };
    }>();
    expect(status.upstreams.map((u) => [u.source, u.state])).toEqual([
      ['primary', 'disabled'],
      ['batam', 'disabled'],
    ]);
    expect(status.pushers.connections).toBe(0);
    expect(status.pushers.activity.published).toBeGreaterThanOrEqual(5);
    expect(status.pushers.activity.rejected).toBeGreaterThanOrEqual(5);
    expect(status.pushers.activity.duplicates).toBeGreaterThanOrEqual(3);

    const metrics = await ingestor.app.inject({ url: '/metrics' });
    expect(metrics.body).toContain(
      'aisits_ais_messages_total{source="pusher",outcome="published"}',
    );
    expect(metrics.body).toContain('aisits_ais_rejections_total');
  });

  it('publishes to the AIS_RAW subject of its feed only', async () => {
    const all = await readEvents(ingestor.app, {
      stream: 'AIS_RAW',
      filterSubjects: [SUBJECT_FILTERS.AIS_RAW],
      eventTypes: [EVENT_TYPES.AIS_RAW_RECEIVED],
      from: startedAt,
    });
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all.map((stored) => stored.subject))).toEqual(
      new Set([subjects.aisRaw('pusher')]),
    );
    expect(all.every((stored) => stored.event.source === 'ais-ingestor')).toBe(
      true,
    );
  });
});
