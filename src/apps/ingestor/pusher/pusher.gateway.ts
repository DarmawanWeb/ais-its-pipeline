import { DomainError, InjectConfig } from '@darmawanweb/ais-its-nest';
import { type ApiKeyPrincipal, Public } from '@darmawanweb/ais-its-nest/auth';
import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

import type { IngestorConfig } from '../config.js';
import { IngestMetrics } from '../ingest/ingest.metrics.js';
import {
  type IngestError,
  IngestService,
  messagesOf,
} from '../ingest/ingest.service.js';
import {
  PusherAuthenticator,
  PusherConnectError,
} from './pusher-authenticator.js';
import { TokenBucket } from './token-bucket.js';

/** socket.io path of the pusher endpoint (gateway route `/api/v2/ingest`). */
export const PUSHER_SOCKET_PATH = '/api/v2/ingest/socket';

/** Event of a pushed report or batch (legacy `ws-server.ts`). */
export const PUSHER_DATA_EVENT = 'ais:data';

/** Largest socket.io message accepted [bytes] (≈ 1000 legacy messages with headroom). */
export const PUSHER_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

/** Acknowledgement of an `ais:data` event (when the pusher asks for one). */
export interface PusherAck {
  readonly accepted: number;
  readonly rejected: number;
  readonly errors: readonly IngestError[];
  /** A problem with the whole event (rate limit, shape, authentication, storage). */
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryAfterMs?: number;
  };
}

/** Per-connection state. */
interface Pusher {
  readonly principal: ApiKeyPrincipal;
  readonly bucket: TokenBucket;
}

/**
 * socket.io endpoint for pushers (spec §13.2): handshake `auth: { apiKey }`
 * with the `ais:ingest` scope, event `ais:data` with one legacy message or
 * an array (≤ 1000), acknowledged with `{ accepted, rejected, errors }`.
 * Each connection is rate limited by a token bucket
 * (`INGEST_SOCKET_RATE_PER_S`, `INGEST_SOCKET_BURST`).
 *
 * `@Public()`: the kit's guard denies non-HTTP handlers otherwise; the
 * connection is authenticated by the handshake middleware instead.
 */
@Public()
@WebSocketGateway({
  path: PUSHER_SOCKET_PATH,
  serveClient: false,
  maxHttpBufferSize: PUSHER_MAX_MESSAGE_BYTES,
})
export class PusherGateway
  implements
    OnGatewayInit<Server>,
    OnGatewayConnection<Socket>,
    OnGatewayDisconnect<Socket>
{
  private readonly logger = new Logger(PusherGateway.name);
  private readonly pushers = new WeakMap<Socket, Pusher>();
  private readonly handshakes = new WeakMap<Socket, ApiKeyPrincipal>();
  private connections = 0;

  constructor(
    private readonly authenticator: PusherAuthenticator,
    private readonly ingest: IngestService,
    private readonly metrics: IngestMetrics,
    @InjectConfig() private readonly config: IngestorConfig,
  ) {}

  /** Authenticates every handshake before `connection`. */
  afterInit(server: Server): void {
    server.use((socket, next) => {
      this.authenticator.authenticate(socket.handshake).then(
        (principal) => {
          this.handshakes.set(socket, principal);
          next();
        },
        (error: unknown) => {
          next(new PusherConnectError(error));
        },
      );
    });
  }

  handleConnection(socket: Socket): void {
    const principal = this.handshakes.get(socket);
    if (principal === undefined) {
      socket.disconnect(true);
      return;
    }
    this.pushers.set(socket, {
      principal,
      bucket: new TokenBucket(
        this.config.INGEST_SOCKET_RATE_PER_S,
        this.config.INGEST_SOCKET_BURST,
      ),
    });
    this.connections += 1;
    this.metrics.instruments.pusherConnections.set(this.connections);
    this.logger.log(
      `Pusher connected: key ${principal.id} (${principal.name})`,
    );
  }

  handleDisconnect(socket: Socket): void {
    if (!this.pushers.has(socket)) return;
    this.pushers.delete(socket);
    this.connections -= 1;
    this.metrics.instruments.pusherConnections.set(this.connections);
  }

  /** Open pusher connections (status). */
  connectionCount(): number {
    return this.connections;
  }

  @SubscribeMessage(PUSHER_DATA_EVENT)
  async onData(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: unknown,
  ): Promise<PusherAck> {
    const pusher = this.pushers.get(socket);
    if (pusher === undefined) {
      return refused(0, 'UNAUTHORIZED', 'Not authenticated');
    }
    const batch = messagesOf(payload);
    if (!batch.ok) {
      return refused(
        Array.isArray(payload) ? payload.length : 1,
        'VALIDATION_FAILED',
        batch.problem.message,
      );
    }
    const count = batch.messages.length;
    try {
      // Re-check the key (cached): revoked keys are refused and disconnected.
      await this.authenticator.authenticate(socket.handshake);
    } catch (error) {
      socket.disconnect(true);
      const problem = new PusherConnectError(error).data;
      return refused(count, problem.code, problem.detail ?? problem.code);
    }
    const waitMs = pusher.bucket.take(count);
    if (waitMs > 0) {
      this.ingest.countRateLimited('pusher', count);
      return {
        ...refused(
          count,
          'RATE_LIMITED',
          'Rate limit of this connection exceeded',
        ),
        error: {
          code: 'RATE_LIMITED',
          message: 'Rate limit of this connection exceeded',
          ...(Number.isFinite(waitMs) ? { retryAfterMs: waitMs } : {}),
        },
      };
    }
    try {
      return await this.ingest.ingestBatch(batch.messages, 'pusher');
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return refused(count, error.code, error.detail ?? error.title);
    }
  }
}

/** An acknowledgement refusing the whole event. */
function refused(count: number, code: string, message: string): PusherAck {
  return { accepted: 0, rejected: count, errors: [], error: { code, message } };
}
