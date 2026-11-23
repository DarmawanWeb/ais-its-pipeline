import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PositionsRepository } from '../src/apps/processor/positions/positions.repository.js';
import { TrafficSampler } from '../src/apps/processor/stats/traffic-sampler.js';
import { moved, normalizedMessage } from './support/messages.js';
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

const TRACKED = 525005301; // 41 reports, 15 s apart, with one detour
const BATAM = 525005302; // two recent reports off Batam
const STALE = 525005303; // last seen two days ago

interface TrackBody {
  mmsi: number;
  resolution: string;
  simplifyM: number | null;
  truncated: boolean;
  remainingTo: string | null;
  points: { time: string; lat: number; lon: number; samples?: number }[];
}

describe('processor: AIS query API', () => {
  let auth: TestAuth;
  let ingestor: TestIngestor;
  let processor: TestProcessor;
  let viewer: { authorization: string };
  let now: number;
  const trackStart = (): number => now - 12 * 60_000;
  const trackTime = (i: number): string =>
    new Date(trackStart() + i * 15_000).toISOString();

  function get(url: string, headers: Record<string, string> = viewer) {
    return processor.app.inject({ url, headers });
  }

  beforeAll(async () => {
    auth = await startTestAuth();
    // The fixture backfills a vessel last seen two days ago (default maximum age 24 h).
    ingestor = await startIngestor(auth, {
      INGEST_MAX_POSITION_AGE_S: String(3 * 86_400),
    });
    await purgeStreams(ingestor.app, ['AIS_RAW', 'AIS_POSITION']);
    processor = await startProcessor(auth, await resetProcessorSchema());
    viewer = await auth.bearer({ roles: ['viewer'] });

    now = Math.floor(Date.now() / 1000) * 1000;
    const start = { lat: -7.0, lon: 112.8 };
    const tracked = Array.from({ length: 41 }, (_, i) =>
      normalizedMessage({
        mmsi: TRACKED,
        // ≈ 62 m east per report (8 kn), the 21st report 300 m off the line.
        ...moved(start, i === 20 ? 300 : 0, i * 62),
        sog: 8 + (i % 3),
        cog: 90,
        hdg: 91,
        timestamp: new Date(trackStart() + i * 15_000),
      }),
    );
    const batam = { lat: 1.1, lon: 104.0 };
    const response = await ingestor.app.inject({
      method: 'POST',
      url: '/api/v2/ingest/ais',
      headers: { 'x-api-key': auth.apiKey(['ais:ingest']) },
      payload: [
        ...tracked,
        normalizedMessage({
          mmsi: BATAM,
          ...batam,
          sog: 1,
          timestamp: new Date(now - 30_000),
        }),
        normalizedMessage({
          mmsi: BATAM,
          ...moved(batam, 100, 0),
          sog: 1,
          timestamp: new Date(now - 10_000),
        }),
        normalizedMessage({
          mmsi: STALE,
          lat: -6.1,
          lon: 106.85,
          timestamp: new Date(now - 2 * 86_400_000),
        }),
      ],
    });
    expect(response.json()).toMatchObject({ accepted: 44, rejected: 0 });
    await waitFor(async () => {
      const { rows } = await processor.pool.query<{ count: string }>(
        'SELECT count(*) FROM positions',
      );
      return Number(rows[0]?.count) === 44;
    });
    await waitFor(async () => {
      const { rows } = await processor.pool.query<{ count: string }>(
        'SELECT count(*) FROM vessel_latest',
      );
      return Number(rows[0]?.count) === 3;
    });
  });

  afterAll(async () => {
    await processor.app.close();
    await ingestor.app.close();
    await auth.close();
  });

  it('requires ais:read: users with the permission and API keys with the scope', async () => {
    expect((await get('/api/v2/ais/latest', {})).statusCode).toBe(401);
    const ingestOnly = await get('/api/v2/ais/latest', {
      'x-api-key': auth.apiKey(['ais:ingest']),
    });
    expect(ingestOnly.statusCode).toBe(403);
    expect(ingestOnly.json()).toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
    const reader = await get('/api/v2/ais/latest', {
      'x-api-key': auth.apiKey(['ais:read']),
    });
    expect(reader.statusCode).toBe(200);
    for (const role of ['authority', 'fleet_manager', 'viewer'] as const) {
      const response = await get(
        '/api/v2/ais/stats',
        await auth.bearer({ roles: [role] }),
      );
      expect(response.statusCode).toBe(200);
    }
  });

  it('GET /ais/latest: vessels seen in the last 24 h, newest first, with since, bbox and limit', async () => {
    const latest = (await get('/api/v2/ais/latest')).json<
      { mmsi: number; time: string; lat: number; lon: number; source: string }[]
    >();
    expect(latest.map((vessel) => vessel.mmsi)).toEqual([BATAM, TRACKED]);
    const { lat, lon, ...tracked } = latest[1] ?? { lat: NaN, lon: NaN };
    expect(tracked).toEqual({
      mmsi: TRACKED,
      time: trackTime(40),
      sog: 9,
      cog: 90,
      hdg: 91,
      navstatus: 0,
      predictedNavstatus: 0,
      source: 'pusher',
    });
    expect([lat, lon].every(Number.isFinite)).toBe(true);

    const since = new Date(now - 3 * 86_400_000).toISOString();
    const all = (await get(`/api/v2/ais/latest?since=${since}`)).json<
      { mmsi: number }[]
    >();
    expect(all.map((vessel) => vessel.mmsi)).toEqual([BATAM, TRACKED, STALE]);

    const inBatam = (
      await get('/api/v2/ais/latest?bbox=103.5,0.5,104.5,1.5')
    ).json<{ mmsi: number }[]>();
    expect(inBatam.map((vessel) => vessel.mmsi)).toEqual([BATAM]);

    const newest = await get('/api/v2/ais/latest?limit=1');
    expect(newest.json<{ mmsi: number }[]>().map((v) => v.mmsi)).toEqual([
      BATAM,
    ]);
    // Truncation is signalled (the least recently seen vessel was left out).
    expect(newest.headers['x-truncated']).toBe('true');
    expect(
      (await get('/api/v2/ais/latest?limit=2')).headers['x-truncated'],
    ).toBe('false');
    // Readable by cross-origin browser clients (CORS_ORIGINS).
    const cors = await get('/api/v2/ais/latest?limit=1', {
      ...viewer,
      origin: 'http://localhost:5173',
    });
    expect(
      String(cors.headers['access-control-expose-headers']).split(/,\s*/),
    ).toContain('X-Truncated');

    for (const query of [
      'bbox=1,2,3',
      'bbox=104,1,103,2',
      'limit=0',
      'since=yesterday',
    ]) {
      const invalid = await get(`/api/v2/ais/latest?${query}`);
      expect(invalid.statusCode, query).toBe(400);
      expect(invalid.json(), query).toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
  });

  it('GET /ais/vessels/:mmsi/latest: the latest position, 404 problem details for an unknown vessel', async () => {
    const latest = await get(`/api/v2/ais/vessels/${BATAM}/latest`);
    expect(latest.json()).toMatchObject({
      mmsi: BATAM,
      time: new Date(now - 10_000).toISOString(),
    });

    const unknown = await get('/api/v2/ais/vessels/525009999/latest');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(unknown.json()).toMatchObject({
      code: 'AIS_POSITION_NOT_FOUND',
      status: 404,
      type: 'urn:ais-its:problem:ais-position-not-found',
    });
    // Path parameters are nine-digit MMSIs (kit @MmsiParam): field errors.
    for (const mmsi of ['12345', '0525005223', '5250052e3']) {
      const invalid = await get(`/api/v2/ais/vessels/${mmsi}/latest`);
      expect(invalid.statusCode, mmsi).toBe(400);
      expect(invalid.json(), mmsi).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [{ field: 'mmsi', code: 'isMmsi' }],
      });
    }
  });

  it('GET /ais/latest?mmsi=: batch lookup of listed vessels whatever their age, unknown ones omitted', async () => {
    const batch = await get(
      `/api/v2/ais/latest?mmsi=${STALE},${TRACKED},525009999,${TRACKED}`,
    );
    expect(batch.statusCode).toBe(200);
    expect(batch.headers['x-truncated']).toBe('false');
    // Newest first; the vessel last seen two days ago is included (no default since).
    expect(
      batch
        .json<{ mmsi: number; time: string }[]>()
        .map((vessel) => [vessel.mmsi, vessel.time]),
    ).toEqual([
      [TRACKED, trackTime(40)],
      [STALE, new Date(now - 2 * 86_400_000).toISOString()],
    ]);
    // An explicit since still filters.
    const since = new Date(now - 3_600_000).toISOString();
    const recent = await get(
      `/api/v2/ais/latest?mmsi=${STALE},${TRACKED}&since=${since}`,
    );
    expect(recent.json<{ mmsi: number }[]>().map((v) => v.mmsi)).toEqual([
      TRACKED,
    ]);
    // Repeated parameters work too.
    const repeated = await get(
      `/api/v2/ais/latest?mmsi=${BATAM}&mmsi=${TRACKED}`,
    );
    expect(repeated.json<{ mmsi: number }[]>().map((v) => v.mmsi)).toEqual([
      BATAM,
      TRACKED,
    ]);

    const tooMany = Array.from({ length: 101 }, (_, i) => 525_100_000 + i);
    for (const [mmsi, code] of [
      ['', 'isMmsi'],
      ['12345', 'isMmsi'],
      [`${TRACKED},0525005223`, 'isMmsi'],
      [tooMany.join(','), 'arrayMaxSize'],
    ] as const) {
      const invalid = await get(`/api/v2/ais/latest?mmsi=${mmsi}`);
      expect(invalid.statusCode, mmsi).toBe(400);
      expect(invalid.json(), mmsi).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [{ field: 'mmsi', code }],
      });
    }
  });

  it('GET /ais/vessels/:mmsi/track: raw positions of the last 24 h in time order, a range, and Douglas–Peucker simplification', async () => {
    const track = (
      await get(`/api/v2/ais/vessels/${TRACKED}/track`)
    ).json<TrackBody>();
    expect(track).toMatchObject({
      mmsi: TRACKED,
      resolution: 'raw',
      simplifyM: null,
      truncated: false,
      remainingTo: null,
    });
    expect(track.points.map((point) => point.time)).toEqual(
      Array.from({ length: 41 }, (_, i) => trackTime(i)),
    );

    const from = trackTime(10);
    const to = trackTime(19);
    const range = (
      await get(`/api/v2/ais/vessels/${TRACKED}/track?from=${from}&to=${to}`)
    ).json<TrackBody>();
    expect(range.points).toHaveLength(10);

    const simplified = (
      await get(`/api/v2/ais/vessels/${TRACKED}/track?simplify=50`)
    ).json<TrackBody>();
    expect(simplified.simplifyM).toBe(50);
    expect(simplified.points.map((point) => point.time)).toEqual(
      [0, 19, 20, 21, 40].map((i) => trackTime(i)),
    );
  });

  it('GET /ais/vessels/:mmsi/track?resolution=1m: one-minute buckets from the continuous aggregate', async () => {
    const minutes = (
      await get(`/api/v2/ais/vessels/${TRACKED}/track?resolution=1m`)
    ).json<TrackBody>();
    expect(minutes.resolution).toBe('1m');
    expect(minutes.points.length).toBeGreaterThanOrEqual(10);
    expect(minutes.points.length).toBeLessThanOrEqual(11);
    expect(
      minutes.points.reduce((sum, point) => sum + (point.samples ?? 0), 0),
    ).toBe(41);
    for (const point of minutes.points)
      expect(new Date(point.time).getUTCSeconds()).toBe(0);
    const times = minutes.points.map((point) => point.time);
    expect([...times].sort()).toEqual(times);
  });

  it('reads the NEWEST points of a range when a track is limited, in time order (a truncated track keeps its end)', async () => {
    const repository = processor.app.get(PositionsRepository);
    const range = {
      mmsi: TRACKED,
      from: new Date(trackTime(0)),
      to: new Date(trackTime(40)),
    };
    const raw = await repository.rawTrack({ ...range, limit: 3 });
    expect(raw.map((point) => point.time.toISOString())).toEqual(
      [38, 39, 40].map((i) => trackTime(i)),
    );
    const minutes = await repository.minuteTrack({
      ...range,
      from: new Date(Math.floor(Date.parse(trackTime(0)) / 60_000) * 60_000),
      limit: 2,
    });
    expect(minutes).toHaveLength(2);
    const [older, newest] = minutes.map((point) => point.time.getTime());
    expect(newest).toBe(
      Math.floor(Date.parse(trackTime(40)) / 60_000) * 60_000,
    );
    expect(older).toBe((newest ?? 0) - 60_000);
  });

  it('limits track ranges: raw ≤ 7 days, 1m ≤ 90 days', async () => {
    const eightDaysAgo = new Date(now - 8 * 86_400_000).toISOString();
    const raw = await get(
      `/api/v2/ais/vessels/${TRACKED}/track?from=${eightDaysAgo}`,
    );
    expect(raw.statusCode).toBe(400);
    const minute = await get(
      `/api/v2/ais/vessels/${TRACKED}/track?from=${eightDaysAgo}&resolution=1m`,
    );
    expect(minute.statusCode).toBe(200);
  });

  it('GET /ais/pairs/track: both raw tracks over the same range (legacy /ais/routes/:mmsi1/:mmsi2)', async () => {
    const from = new Date(now - 15 * 60_000).toISOString();
    const to = new Date(now).toISOString();
    const pair = (
      await get(
        `/api/v2/ais/pairs/track?mmsi1=${TRACKED}&mmsi2=${BATAM}&from=${from}&to=${to}`,
      )
    ).json<{ from: string; to: string; tracks: TrackBody[] }>();
    expect(pair.from).toBe(from);
    expect(pair.to).toBe(to);
    expect(
      pair.tracks.map((track) => [track.mmsi, track.points.length]),
    ).toEqual([
      [TRACKED, 41],
      [BATAM, 2],
    ]);
    expect((await get('/api/v2/ais/pairs/track?mmsi1=1')).statusCode).toBe(400);
  });

  it('GET /ais/pairs/track: the resolution and simplification of the vessel track for both vessels', async () => {
    const pair = (query: string) =>
      get(`/api/v2/ais/pairs/track?mmsi1=${TRACKED}&mmsi2=${BATAM}&${query}`);
    const minutes = (await pair('resolution=1m')).json<{
      tracks: TrackBody[];
    }>();
    expect(minutes.tracks.map((track) => track.resolution)).toEqual([
      '1m',
      '1m',
    ]);
    const [tracked, batam] = minutes.tracks;
    expect(tracked?.points.length).toBeGreaterThanOrEqual(10);
    expect(tracked?.points.length).toBeLessThanOrEqual(11);
    expect(
      tracked?.points.reduce((sum, point) => sum + (point.samples ?? 0), 0),
    ).toBe(41);
    expect(
      batam?.points.reduce((sum, point) => sum + (point.samples ?? 0), 0),
    ).toBe(2);

    const simplified = (await pair('simplify=50')).json<{
      tracks: TrackBody[];
    }>();
    expect(simplified.tracks.map((track) => track.simplifyM)).toEqual([50, 50]);
    expect(simplified.tracks[0]?.points.map((point) => point.time)).toEqual(
      [0, 19, 20, 21, 40].map((i) => trackTime(i)),
    );

    // The range limit follows the resolution: raw ≤ 7 days, 1m ≤ 90 days.
    const eightDaysAgo = new Date(now - 8 * 86_400_000).toISOString();
    expect((await pair(`from=${eightDaysAgo}`)).statusCode).toBe(400);
    expect((await pair(`from=${eightDaysAgo}&resolution=1m`)).statusCode).toBe(
      200,
    );
    expect((await pair('resolution=5m')).statusCode).toBe(400);
  });

  it('GET /ais/stats: active vessels (10 min) and positions of the last minute, by feed', async () => {
    const stats = (await get('/api/v2/ais/stats')).json<
      Record<string, unknown>
    >();
    expect(stats).toMatchObject({
      activeVessels: 2,
      messagesLastMinute: 2,
      activeWindowMinutes: 10,
      bySource: {
        primary: { activeVessels: 0, messagesLastMinute: 0 },
        batam: { activeVessels: 0, messagesLastMinute: 0 },
        pusher: { activeVessels: 2, messagesLastMinute: 2 },
      },
    });
  });

  it('GET /ais/stats/series: the sampled history of /ais/stats per minute and in 5-minute buckets, by feed', async () => {
    const sampler = processor.app.get(TrafficSampler);
    // Five full minutes inside the tracked vessel's reports (4 per minute).
    const first = Math.ceil(trackStart() / 60_000) * 60_000;
    const minutes = [0, 1, 2, 3, 4].map((i) => new Date(first + i * 60_000));
    for (const minute of minutes)
      expect(await sampler.sample(minute)).toBe('recorded');
    // Another replica sampling the same minute changes nothing.
    expect(await sampler.sample(minutes[0])).toBe('exists');

    const from = new Date(first).toISOString();
    const to = new Date(first + 5 * 60_000).toISOString();
    const response = await get(
      `/api/v2/ais/stats/series?from=${from}&to=${to}`,
    );
    expect(response.statusCode).toBe(200);
    const series = response.json<{
      from: string;
      to: string;
      bucket: string;
      bucketMinutes: number;
      activeWindowMinutes: number;
      points: {
        at: string;
        samples: number;
        messages: number;
        activeVessels: number;
        bySource: Record<string, { messages: number; activeVessels: number }>;
      }[];
    }>();
    expect(series).toMatchObject({
      from,
      to,
      bucket: '1m',
      bucketMinutes: 1,
      activeWindowMinutes: 10,
    });
    // Active at the end of each minute: the tracked vessel and Batam (the
    // stale vessel's latest position is two days old).
    expect(
      series.points.map((point) => [
        point.at,
        point.samples,
        point.messages,
        point.activeVessels,
      ]),
    ).toEqual(minutes.map((minute) => [minute.toISOString(), 1, 4, 2]));
    expect(series.points[0]?.bySource).toEqual({
      primary: { messages: 0, activeVessels: 0 },
      batam: { messages: 0, activeVessels: 0 },
      pusher: { messages: 4, activeVessels: 2 },
    });

    const coarse = (
      await get(`/api/v2/ais/stats/series?from=${from}&to=${to}&bucket=5m`)
    ).json<typeof series>();
    expect(coarse.bucketMinutes).toBe(5);
    expect(new Date(coarse.from).getTime() % 300_000).toBe(0);
    expect(coarse.points.length).toBeGreaterThanOrEqual(1);
    expect(coarse.points.length).toBeLessThanOrEqual(2);
    expect(coarse.points.reduce((sum, p) => sum + p.samples, 0)).toBe(5);
    expect(coarse.points.reduce((sum, p) => sum + p.messages, 0)).toBe(20);
    expect(coarse.points.every((p) => p.activeVessels === 2)).toBe(true);

    // Defaults, permissions and limits.
    const latest = await get('/api/v2/ais/stats/series', {
      'x-api-key': auth.apiKey(['ais:read']),
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json()).toMatchObject({ bucket: '1m' });
    expect((await get('/api/v2/ais/stats/series', {})).statusCode).toBe(401);
    const twoDaysAgo = new Date(now - 2 * 86_400_000).toISOString();
    for (const query of ['bucket=2m', `from=${twoDaysAgo}`, 'from=yesterday']) {
      const invalid = await get(`/api/v2/ais/stats/series?${query}`);
      expect(invalid.statusCode, query).toBe(400);
      expect(invalid.json(), query).toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    expect(
      (await get(`/api/v2/ais/stats/series?from=${twoDaysAgo}&bucket=5m`))
        .statusCode,
    ).toBe(200);
  });

  it('GET /ais/methodology: the catalog methods this repository implements', async () => {
    const response = await get('/api/v2/ais/methodology');
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      service: string;
      methods: { id: string }[];
    }>();
    expect(body.service).toBe('ais-processor');
    expect(body.methods.map((method) => method.id)).toEqual(
      expect.arrayContaining([
        'data.ais_ingest_rules',
        'data.ais_position_time',
        'geo.track_simplification',
        'navstatus.prediction',
        'geo.coast_distance',
        'data.indonesia_coastline',
        'geo.haversine_distance',
      ]),
    );

    const document = (
      await processor.app.inject({ url: '/openapi.json' })
    ).json<{
      paths: Record<string, unknown>;
    }>();
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        '/api/v2/ais/latest',
        '/api/v2/ais/methodology',
        '/api/v2/ais/pairs/track',
        '/api/v2/ais/stats',
        '/api/v2/ais/stats/series',
        '/api/v2/ais/vessels/{mmsi}/latest',
        '/api/v2/ais/vessels/{mmsi}/track',
      ].sort(),
    );
  });
});
