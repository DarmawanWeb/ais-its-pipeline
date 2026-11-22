import {
  APP_CONFIG,
  type DomainError,
  ForbiddenError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '@darmawanweb/ais-its-nest';
import { ApiKeyPrincipal } from '@darmawanweb/ais-its-nest/auth';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { Test } from '@nestjs/testing';
import type { Server, Socket } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IngestorConfig } from '../config.js';
import { IngestMetrics } from '../ingest/ingest.metrics.js';
import { IngestService } from '../ingest/ingest.service.js';
import { PusherAuthenticator } from './pusher-authenticator.js';
import {
  PUSHER_AUTH_RETRY_AFTER_MS,
  type PusherAck,
  PusherGateway,
  refusesKey,
} from './pusher.gateway.js';

const NOW = Date.UTC(2026, 10, 22, 8, 0, 0);
const GRACE_S = 300;
const PRINCIPAL = new ApiKeyPrincipal({
  id: 'key-1',
  orgId: '0196a0e8-0000-7000-8000-000000000001',
  scopes: ['ais:ingest'],
  name: 'test pusher',
});
const MESSAGE = {
  message: {
    data: { mmsi: '525005223', navstatus: 0, lat: -7.2, lon: 112.7 },
  },
};

/** A connected socket and its `disconnect` spy. */
function fakeSocket(): {
  socket: Socket;
  disconnect: ReturnType<typeof vi.fn>;
} {
  const disconnect = vi.fn();
  const socket = {
    handshake: { auth: { apiKey: 'sk_test' } },
    disconnect,
  } as unknown as Socket;
  return { socket, disconnect };
}

async function createGateway(config: Partial<IngestorConfig> = {}) {
  const authenticate = vi.fn<PusherAuthenticator['authenticate']>(() =>
    Promise.resolve(PRINCIPAL),
  );
  const ingestBatch = vi.fn((messages: readonly unknown[]) =>
    Promise.resolve({ accepted: messages.length, rejected: 0, errors: [] }),
  );
  const moduleRef = await Test.createTestingModule({
    providers: [
      PusherGateway,
      IngestMetrics,
      MetricsService,
      { provide: PusherAuthenticator, useValue: { authenticate } },
      {
        provide: IngestService,
        useValue: { ingestBatch, countRateLimited: vi.fn() },
      },
      {
        provide: APP_CONFIG,
        useValue: {
          INGEST_SOCKET_RATE_PER_S: 1000,
          INGEST_SOCKET_BURST: 1000,
          INGEST_SOCKET_AUTH_GRACE_S: GRACE_S,
          ...config,
        },
      },
    ],
  }).compile();
  const gateway = moduleRef.get(PusherGateway);
  const metrics = moduleRef.get(IngestMetrics);

  /** Runs the handshake middleware and the connection handler for `socket`. */
  async function connect(socket: Socket): Promise<void> {
    let middleware: Parameters<Server['use']>[0] | undefined;
    gateway.afterInit({
      use: (fn: Parameters<Server['use']>[0]) => {
        middleware = fn;
      },
    } as unknown as Server);
    await new Promise<void>((resolve, reject) => {
      middleware?.(socket, (error?: Error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
    gateway.handleConnection(socket);
  }

  async function unavailableCount(result: 'grace' | 'refused') {
    const { values } = await metrics.instruments.pusherAuthUnavailable.get();
    return values.find((value) => value.labels.result === result)?.value ?? 0;
  }

  return { gateway, authenticate, ingestBatch, connect, unavailableCount };
}

describe('refusesKey', () => {
  it('refuses the key for 401 and 403, not for an unavailable introspection or unexpected errors', () => {
    expect(refusesKey(new UnauthorizedError('revoked'))).toBe(true);
    expect(refusesKey(new ForbiddenError('scope'))).toBe(true);
    expect(refusesKey(new ServiceUnavailableError('down'))).toBe(false);
    expect(refusesKey(new Error('socket hang up'))).toBe(false);
  });
});

describe('PusherGateway: API-key re-check on every ais:data event', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts events while the key verifies and keeps the connection', async () => {
    const { gateway, ingestBatch, connect } = await createGateway();
    const { socket, disconnect } = fakeSocket();
    await connect(socket);

    const ack = await gateway.onData(socket, [MESSAGE, MESSAGE]);
    expect(ack).toEqual({ accepted: 2, rejected: 0, errors: [] });
    expect(ingestBatch).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('keeps the socket open through an introspection outage: the last verified key is used for the grace period, then events are refused as retryable', async () => {
    const { gateway, authenticate, ingestBatch, connect, unavailableCount } =
      await createGateway();
    const { socket, disconnect } = fakeSocket();
    await connect(socket);
    // The kit's 60 s cache expired and auth is restarting: introspection fails with 503.
    authenticate.mockRejectedValue(
      new ServiceUnavailableError('API-key introspection is unavailable'),
    );

    vi.setSystemTime(NOW + (GRACE_S - 1) * 1000);
    expect(await gateway.onData(socket, MESSAGE)).toEqual({
      accepted: 1,
      rejected: 0,
      errors: [],
    });
    expect(await unavailableCount('grace')).toBe(1);

    vi.setSystemTime(NOW + (GRACE_S + 1) * 1000);
    const refused: PusherAck = await gateway.onData(socket, [MESSAGE, MESSAGE]);
    expect(refused).toMatchObject({
      accepted: 0,
      rejected: 2,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        retryAfterMs: PUSHER_AUTH_RETRY_AFTER_MS,
      },
    });
    expect(ingestBatch).toHaveBeenCalledOnce();
    expect(await unavailableCount('refused')).toBe(1);
    // A server-side disconnect is never retried by socket.io clients.
    expect(disconnect).not.toHaveBeenCalled();

    // Auth is back: the connection resumes without reconnecting.
    authenticate.mockResolvedValue(PRINCIPAL);
    expect(await gateway.onData(socket, MESSAGE)).toMatchObject({
      accepted: 1,
    });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('refreshes the grace period with every successful verification', async () => {
    const { gateway, authenticate, connect } = await createGateway();
    const { socket } = fakeSocket();
    await connect(socket);

    vi.setSystemTime(NOW + 10 * 60_000);
    expect(await gateway.onData(socket, MESSAGE)).toMatchObject({
      accepted: 1,
    });
    authenticate.mockRejectedValue(new ServiceUnavailableError('down'));
    vi.setSystemTime(NOW + 10 * 60_000 + (GRACE_S - 1) * 1000);
    expect(await gateway.onData(socket, MESSAGE)).toMatchObject({
      accepted: 1,
    });
  });

  it('refuses at once without a grace period (INGEST_SOCKET_AUTH_GRACE_S = 0), still without disconnecting', async () => {
    const { gateway, authenticate, connect } = await createGateway({
      INGEST_SOCKET_AUTH_GRACE_S: 0,
    });
    const { socket, disconnect } = fakeSocket();
    await connect(socket);
    authenticate.mockRejectedValue(new ServiceUnavailableError('down'));
    vi.setSystemTime(NOW + 1);

    expect(await gateway.onData(socket, MESSAGE)).toMatchObject({
      accepted: 0,
      error: { code: 'SERVICE_UNAVAILABLE' },
    });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it.each<[string, DomainError, string]>([
    [
      'revoked key (401 INVALID_API_KEY)',
      new UnauthorizedError('The API key is not valid', {
        code: 'INVALID_API_KEY',
      }),
      'INVALID_API_KEY',
    ],
    [
      'scope removed (403 INSUFFICIENT_SCOPE)',
      new ForbiddenError('The API key lacks the scope ais:ingest', {
        code: 'INSUFFICIENT_SCOPE',
      }),
      'INSUFFICIENT_SCOPE',
    ],
  ])(
    'disconnects a pusher whose key is refused: %s',
    async (_label, error, code) => {
      const { gateway, authenticate, ingestBatch, connect } =
        await createGateway();
      const { socket, disconnect } = fakeSocket();
      await connect(socket);
      authenticate.mockRejectedValue(error);

      expect(await gateway.onData(socket, MESSAGE)).toMatchObject({
        accepted: 0,
        rejected: 1,
        error: { code },
      });
      expect(disconnect).toHaveBeenCalledWith(true);
      expect(ingestBatch).not.toHaveBeenCalled();
    },
  );
});
