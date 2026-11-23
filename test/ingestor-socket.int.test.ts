import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  type AisRawReceivedV1,
  EVENT_TYPES,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PUSHER_SOCKET_PATH } from '../src/apps/ingestor/pusher/pusher.gateway.js';
import { legacyMessage, positionTimeOf } from './support/messages.js';
import {
  readEvents,
  startIngestor,
  startTestAuth,
  type TestAuth,
  type TestIngestor,
} from './support/test-apps.js';

const UPSTREAM_TOKEN = 'upstream-token-for-tests';

/** A local stand-in for an upstream AIS socket.io server. */
interface FakeUpstream {
  io: Server;
  http: HttpServer;
  readonly port: number;
  /** `auth.token` of every handshake received. */
  readonly tokens: unknown[];
}

/**
 * Starts a fake upstream on `port` (0: any). `authDelayMs` delays its auth
 * middleware like a real token check: the engine.io connection (counted by
 * `io.engine.clientsCount`) then exists well before the client's socket.io
 * `connect`, which is what the ingestor's state and metrics follow.
 */
async function startUpstream(
  port = 0,
  { authDelayMs = 0 }: { authDelayMs?: number } = {},
): Promise<FakeUpstream> {
  const http = createServer();
  const io = new Server(http, { transports: ['websocket'] });
  const tokens: unknown[] = [];
  io.use((socket, next) => {
    const auth: Record<string, unknown> = socket.handshake.auth;
    tokens.push(auth.token);
    if (authDelayMs === 0) next();
    else setTimeout(next, authDelayMs);
  });
  await new Promise<void>((resolve) => {
    http.listen(port, '127.0.0.1', resolve);
  });
  return {
    io,
    http,
    port: (http.address() as AddressInfo).port,
    tokens,
  };
}

async function stopUpstream(upstream: FakeUpstream): Promise<void> {
  await new Promise<void>((resolve) => {
    void upstream.io.close(() => {
      resolve();
    });
  });
}

/**
 * Whether the ingestor's client of `source` is connected: its socket.io
 * `connect` (after the namespace handshake) sets the gauge, unlike the
 * server-side `io.engine.clientsCount`, which counts the engine.io
 * connection before that handshake completes.
 */
async function upstreamConnected(
  ingestor: TestIngestor,
  source: 'primary' | 'batam',
): Promise<boolean> {
  const metrics = await ingestor.app.inject({ url: '/metrics' });
  return metrics.body.includes(
    `aisits_ais_upstream_connected{source="${source}"} 1`,
  );
}

/** Raw reports of a feed stored since `from`. */
async function rawReports(
  ingestor: TestIngestor,
  source: 'primary' | 'batam' | 'pusher',
  from: Date,
): Promise<AisRawReceivedV1[]> {
  const events = await readEvents(ingestor.app, {
    stream: 'AIS_RAW',
    filterSubjects: [subjects.aisRaw(source)],
    eventTypes: [EVENT_TYPES.AIS_RAW_RECEIVED],
    from,
  });
  return events.flatMap(({ event }) =>
    event.type === EVENT_TYPES.AIS_RAW_RECEIVED ? [event.data] : [],
  );
}

/** Opens a pusher connection; resolves with the socket or the `connect_error`. */
async function openPusher(
  url: string,
  auth: Record<string, unknown>,
): Promise<{ socket: Socket; error: (Error & { data?: unknown }) | null }> {
  const socket = connect(url, {
    path: PUSHER_SOCKET_PATH,
    transports: ['websocket'],
    auth,
    reconnection: false,
  });
  return new Promise((resolve) => {
    socket.once('connect', () => {
      resolve({ socket, error: null });
    });
    socket.once('connect_error', (error: Error & { data?: unknown }) => {
      resolve({ socket, error });
    });
  });
}

interface PusherAck {
  accepted: number;
  rejected: number;
  errors: { index: number; code: string }[];
  error?: { code: string; message: string; retryAfterMs?: number };
}

async function push(socket: Socket, payload: unknown): Promise<PusherAck> {
  return (await socket
    .timeout(10_000)
    .emitWithAck('ais:data', payload)) as PusherAck;
}

describe('ingestor: upstream socket.io feeds and the pusher endpoint', () => {
  let auth: TestAuth;
  let primary: FakeUpstream;
  let batam: FakeUpstream;
  let ingestor: TestIngestor;
  const sockets: Socket[] = [];
  const startedAt = new Date();

  beforeAll(async () => {
    auth = await startTestAuth();
    primary = await startUpstream();
    batam = await startUpstream();
    ingestor = await startIngestor(
      auth,
      {
        AIS_PRIMARY_URL: `http://127.0.0.1:${primary.port}`,
        AIS_BATAM_URL: `http://127.0.0.1:${batam.port}`,
        AIS_UPSTREAM_TOKEN: UPSTREAM_TOKEN,
        AIS_UPSTREAM_RECONNECT_MIN_MS: '100',
        AIS_UPSTREAM_RECONNECT_MAX_MS: '400',
        INGEST_SOCKET_RATE_PER_S: '1',
        INGEST_SOCKET_BURST: '4',
      },
      { listen: true },
    );
    // Connected as the client sees it, not just the engine.io handshake.
    await waitFor(
      async () =>
        (await upstreamConnected(ingestor, 'primary')) &&
        (await upstreamConnected(ingestor, 'batam')),
      { timeoutMs: 10_000 },
    );
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await ingestor.app.close();
    await Promise.all([stopUpstream(primary), stopUpstream(batam)]);
    await auth.close();
  });

  it('connects to both upstreams with the handshake token and the websocket transport', () => {
    expect(primary.tokens).toEqual([UPSTREAM_TOKEN]);
    expect(batam.tokens).toEqual([UPSTREAM_TOKEN]);
  });

  it('publishes messageFromServer reports to ais.raw.v1.<source> and drops invalid ones', async () => {
    const primaryFields = {
      mmsi: '525005151',
      lat: -7.2,
      lon: 112.73,
      sog: 8.5,
      cog: 91,
      hdg: 90,
      utc: 12,
      timestamp: new Date(Date.now() - 20_000),
    };
    const batamFields = {
      mmsi: '525005152',
      lat: 1.1,
      lon: 104,
      timestamp: new Date(Date.now() - 15_000),
    };
    primary.io.emit('messageFromServer', legacyMessage(primaryFields));
    primary.io.emit(
      'messageFromServer',
      legacyMessage({ ...primaryFields, lat: 91 }),
    );
    primary.io.emit('messageFromServer', { message: null });
    batam.io.emit('messageFromServer', legacyMessage(batamFields));

    const fromPrimary = await waitFor(async () => {
      const reports = await rawReports(ingestor, 'primary', startedAt);
      return reports.length > 0 ? reports : null;
    });
    const fromBatam = await waitFor(async () => {
      const reports = await rawReports(ingestor, 'batam', startedAt);
      return reports.length > 0 ? reports : null;
    });

    expect(fromPrimary).toEqual([
      expect.objectContaining({
        source: 'primary',
        mmsi: 525005151,
        positionTime: positionTimeOf(primaryFields),
        sog: 8.5,
      }),
    ]);
    expect(fromBatam).toEqual([
      expect.objectContaining({ source: 'batam', mmsi: 525005152 }),
    ]);
    const status = await ingestor.app.inject({
      url: '/api/v2/ingest/status',
      headers: await auth.bearer({ roles: ['super_admin'] }),
    });
    const primaryStatus = status
      .json<{
        upstreams: {
          source: string;
          state: string;
          activity: { published: number; rejected: number };
        }[];
      }>()
      .upstreams.find((upstream) => upstream.source === 'primary');
    expect(primaryStatus).toMatchObject({
      state: 'connected',
      activity: { published: 1, rejected: 2 },
    });
  });

  it('reconnects with backoff after a server-side disconnect and after a server restart', async () => {
    primary.io.disconnectSockets(true);
    await waitFor(() => primary.tokens.length === 2, { timeoutMs: 10_000 });

    const port = primary.port;
    await stopUpstream(primary);
    // The restarted server checks the token for 500 ms: its engine.io
    // connection is counted that long before the client is connected.
    primary = await startUpstream(port, { authDelayMs: 500 });
    await waitFor(() => primary.io.engine.clientsCount === 1, {
      timeoutMs: 15_000,
    });
    await waitFor(() => upstreamConnected(ingestor, 'primary'), {
      timeoutMs: 15_000,
    });

    const metrics = await ingestor.app.inject({ url: '/metrics' });
    const reconnects =
      /aisits_ais_upstream_reconnects_total\{source="primary"\} (\d+)/.exec(
        metrics.body,
      );
    expect(Number(reconnects?.[1] ?? 0)).toBeGreaterThanOrEqual(2);
    expect(metrics.body).toContain(
      'aisits_ais_upstream_connected{source="primary"} 1',
    );
  });

  it('refuses pushers without an API key or without the ais:ingest scope', async () => {
    const missing = await openPusher(ingestor.url ?? '', {});
    sockets.push(missing.socket);
    expect(missing.error?.data).toMatchObject({
      code: 'INVALID_API_KEY',
      status: 401,
    });

    const unknownKey = await openPusher(ingestor.url ?? '', {
      apiKey: 'sk_unknown0000_00000000000000000000000000000000',
    });
    sockets.push(unknownKey.socket);
    expect(unknownKey.error?.data).toMatchObject({ status: 401 });

    const reader = await openPusher(ingestor.url ?? '', {
      apiKey: auth.apiKey(['ais:read']),
    });
    sockets.push(reader.socket);
    expect(reader.error?.data).toMatchObject({
      code: 'INSUFFICIENT_SCOPE',
      status: 403,
    });
  });

  it('ingests ais:data events (legacy format, single or batch) and acknowledges them', async () => {
    const { socket, error } = await openPusher(ingestor.url ?? '', {
      apiKey: auth.apiKey(['ais:ingest'], 'socket pusher'),
    });
    sockets.push(socket);
    expect(error).toBeNull();

    const fields = {
      mmsi: 525005153,
      lat: -8.15,
      lon: 114.42,
      timestamp: new Date(Date.now() - 10_000),
    };
    expect(await push(socket, legacyMessage(fields))).toEqual({
      accepted: 1,
      rejected: 0,
      errors: [],
    });
    const batch = await push(socket, [
      legacyMessage({ ...fields, timestamp: new Date(Date.now() - 9_000) }),
      legacyMessage({ ...fields, mmsi: '12345' }),
    ]);
    expect(batch).toMatchObject({
      accepted: 1,
      rejected: 1,
      errors: [{ index: 1, code: 'INVALID_MMSI' }],
    });
    expect(await push(socket, 'not a message')).toMatchObject({
      accepted: 0,
      error: { code: 'VALIDATION_FAILED' },
    });

    const stored = await waitFor(async () => {
      const reports = (await rawReports(ingestor, 'pusher', startedAt)).filter(
        (report) => report.mmsi === 525005153,
      );
      return reports.length === 2 ? reports : null;
    });
    expect(stored.every((report) => report.source === 'pusher')).toBe(true);
  });

  it('rate limits each connection with a token bucket', async () => {
    const { socket } = await openPusher(ingestor.url ?? '', {
      apiKey: auth.apiKey(['ais:ingest'], 'fast pusher'),
    });
    sockets.push(socket);
    const message = (offsetMs: number) =>
      legacyMessage({
        mmsi: 525005154,
        lat: -6.1,
        lon: 106.85,
        timestamp: new Date(Date.now() - offsetMs),
      });

    // Burst 4: three pass, the next three exceed the bucket, five never fit.
    expect(
      await push(socket, [message(3000), message(2000), message(1000)]),
    ).toMatchObject({
      accepted: 3,
    });
    const limited = await push(socket, [
      message(900),
      message(800),
      message(700),
    ]);
    expect(limited).toMatchObject({
      accepted: 0,
      rejected: 3,
      error: { code: 'RATE_LIMITED' },
    });
    expect(limited.error?.retryAfterMs).toBeGreaterThan(0);
    const tooLarge = await push(
      socket,
      Array.from({ length: 5 }, () => message(500)),
    );
    expect(tooLarge.error?.code).toBe('RATE_LIMITED');
    expect(tooLarge.error?.retryAfterMs).toBeUndefined();

    const status = await ingestor.app.inject({
      url: '/api/v2/ingest/status',
      headers: await auth.bearer({ roles: ['super_admin'] }),
    });
    expect(
      status.json<{
        pushers: { connections: number; activity: { rateLimited: number } };
      }>().pushers,
    ).toMatchObject({ connections: 2, activity: { rateLimited: 8 } });
  });
});
