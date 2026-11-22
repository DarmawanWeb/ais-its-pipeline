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

/** How long a pusher should wait before retrying while the API-key introspection is unavailable [ms]. */
export const PUSHER_AUTH_RETRY_AFTER_MS = 5000;

/** Per-connection state. */
interface Pusher {
  readonly bucket: TokenBucket;
  /** Last successful verification of the connection's key (epoch ms). */
  verifiedAt: number;
}

/**
 * Whether a failed key check refuses the key itself (`401 INVALID_API_KEY`:
 * unknown, malformed or revoked; `403 INSUFFICIENT_SCOPE`) — as opposed to
 * an unavailable introspection (`503`) or an unexpected failure.
 */
export function refusesKey(error: unknown): boolean {
  return (
    error instanceof DomainError &&
    (error.status === 401 || error.status === 403)
  );
}

/**
 * socket.io endpoint for pushers (spec §13.2): handshake `auth: { apiKey }`
 * with the `ais:ingest` scope, event `ais:data` with one legacy message or
 * an array (≤ 1000), acknowledged with `{ accepted, rejected, errors }`.
 * Each connection is rate limited by a token bucket
 * (`INGEST_SOCKET_RATE_PER_S`, `INGEST_SOCKET_BURST`).
 *
 * The key is re-checked on every event (kit cache: 60 s). A refused key
 * (401/403) disconnects the pusher; an unavailable introspection does not —
 * socket.io clients never reconnect after a server-side disconnect, so an
 * auth outage would drop every pusher for good. The connection's last
 * verified key is used for `INGEST_SOCKET_AUTH_GRACE_S`, then events are
 * refused as retryable (`SERVICE_UNAVAILABLE`, `retryAfterMs`) until the
 * introspection answers again.
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
  private lastAuthWarningAt = 0;
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
      bucket: new TokenBucket(
        this.config.INGEST_SOCKET_RATE_PER_S,
        this.config.INGEST_SOCKET_BURST,
      ),
      verifiedAt: Date.now(),
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
    const authProblem = await this.reverify(socket, pusher, count);
    if (authProblem !== null) return authProblem;
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

  /**
   * Re-checks the connection's key; `null` when the event may proceed,
   * else the acknowledgement refusing it.
   */
  private async reverify(
    socket: Socket,
    pusher: Pusher,
    count: number,
  ): Promise<PusherAck | null> {
    try {
      await this.authenticator.authenticate(socket.handshake);
      pusher.verifiedAt = Date.now();
      return null;
    } catch (error) {
      if (refusesKey(error)) {
        // Unknown, revoked or out-of-scope key: refuse and disconnect.
        socket.disconnect(true);
        const problem = new PusherConnectError(error).data;
        return refused(count, problem.code, problem.detail ?? problem.code);
      }
      const graceMs = this.config.INGEST_SOCKET_AUTH_GRACE_S * 1000;
      const accepted = Date.now() - pusher.verifiedAt <= graceMs;
      this.metrics.instruments.pusherAuthUnavailable.inc({
        result: accepted ? 'grace' : 'refused',
      });
      this.warnAuthUnavailable(error, accepted);
      if (accepted) return null;
      const message =
        'The API key cannot be verified right now; retry later (the connection stays open)';
      return {
        ...refused(count, 'SERVICE_UNAVAILABLE', message),
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message,
          retryAfterMs: PUSHER_AUTH_RETRY_AFTER_MS,
        },
      };
    }
  }

  private warnAuthUnavailable(error: unknown, accepted: boolean): void {
    const now = Date.now();
    if (now - this.lastAuthWarningAt < 10_000) return;
    this.lastAuthWarningAt = now;
    this.logger.warn(
      `Pusher API keys cannot be re-checked (${error instanceof Error ? error.message : String(error)}): ` +
        (accepted
          ? `accepting connected pushers with their last verified key for up to ${this.config.INGEST_SOCKET_AUTH_GRACE_S} s`
          : 'refusing their events as retryable'),
    );
  }
}

/** An acknowledgement refusing the whole event. */
function refused(count: number, code: string, message: string): PusherAck {
  return { accepted: 0, rejected: count, errors: [], error: { code, message } };
}
