import type { Logger } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';

import { reconnectDelayMs } from './backoff.js';

/** Event carrying a legacy `TimestampedAisMessage` (be-legacy/src/config/ws.ts). */
export const UPSTREAM_MESSAGE_EVENT = 'messageFromServer';

/** The upstream feeds (spec §13.2); pushers are the third AIS source. */
export type UpstreamSource = 'primary' | 'batam';

/** Connection state of a feed. */
export type UpstreamState =
  'disabled' | 'connecting' | 'connected' | 'disconnected' | 'stopped';

/** What `GET /ingest/status` reports about a feed. */
export interface UpstreamFeedStatus {
  readonly source: UpstreamSource;
  /** Scheme, host and path of the server (no credentials or query). */
  readonly endpoint: string | null;
  readonly state: UpstreamState;
  readonly connectedSince: Date | null;
  readonly lastDisconnectedAt: Date | null;
  readonly lastError: string | null;
  /** Reconnection attempts since the last successful connection. */
  readonly reconnectAttempts: number;
}

/** Settings of one feed. */
export interface UpstreamFeedOptions {
  readonly source: UpstreamSource;
  readonly url: string;
  /** Handshake `auth.token`. */
  readonly token: string | undefined;
  readonly reconnectMinMs: number;
  readonly reconnectMaxMs: number;
  /** Receives every `messageFromServer` payload with its reception time. */
  readonly onMessage: (message: unknown, receivedAt: Date) => void;
  /** Connection changes (metrics). */
  readonly onConnectionChange?: ((connected: boolean) => void) | undefined;
  /** Every reconnection attempt (metrics). */
  readonly onReconnectAttempt?: (() => void) | undefined;
  readonly logger: Pick<Logger, 'log' | 'warn'>;
}

/** `scheme://host[:port]/path` of a URL, without credentials, query or fragment. */
export function endpointOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
}

/**
 * A socket.io client of one upstream AIS server (legacy `connectSocket` /
 * `batamConnectSocket`: websocket transport, handshake `auth: { token }`,
 * event `messageFromServer`). Transport failures reconnect with the
 * client's exponential backoff (min → max, ±50 % jitter); disconnections
 * the client does not retry on its own (server-side disconnect, handshake
 * refused by the server) are retried here with the same backoff.
 */
export class UpstreamFeed {
  private socket: Socket | null = null;
  private state: UpstreamState = 'stopped';
  private connectedSince: Date | null = null;
  private lastDisconnectedAt: Date | null = null;
  private lastError: string | null = null;
  private reconnectAttempts = 0;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: UpstreamFeedOptions) {}

  /** Opens the connection (idempotent). */
  start(): void {
    if (this.socket !== null) return;
    const { url, token, reconnectMinMs, reconnectMaxMs } = this.options;
    const socket = io(url, {
      ...(token === undefined ? {} : { auth: { token } }),
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: reconnectMinMs,
      reconnectionDelayMax: reconnectMaxMs,
      randomizationFactor: 0.5,
      autoConnect: false,
    });
    socket.on('connect', () => {
      this.state = 'connected';
      this.connectedSince = new Date();
      this.reconnectAttempts = 0;
      this.lastError = null;
      this.options.onConnectionChange?.(true);
      this.options.logger.log(
        `Upstream ${this.options.source} connected (${endpointOf(url)})`,
      );
    });
    socket.on('disconnect', (reason) => {
      const wasConnected = this.state === 'connected';
      this.state = this.socket === null ? 'stopped' : 'disconnected';
      this.connectedSince = null;
      this.lastDisconnectedAt = new Date();
      if (wasConnected) this.options.onConnectionChange?.(false);
      this.options.logger.warn(
        `Upstream ${this.options.source} disconnected: ${reason}`,
      );
      // The client does not reconnect after a server-side disconnect.
      if (reason === 'io server disconnect') this.scheduleRetry();
    });
    socket.on('connect_error', (error: Error) => {
      this.lastError = error.message;
      this.state = 'disconnected';
      // An inactive socket was refused by the server (e.g. its auth middleware).
      if (!socket.active) this.scheduleRetry();
    });
    socket.on(UPSTREAM_MESSAGE_EVENT, (message: unknown) => {
      this.options.onMessage(message, new Date());
    });
    socket.io.on('reconnect_attempt', () => {
      this.reconnectAttempts += 1;
      this.state = 'connecting';
      this.options.onReconnectAttempt?.();
    });
    this.socket = socket;
    this.state = 'connecting';
    socket.connect();
  }

  /** Closes the connection and cancels pending retries. */
  stop(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket === null) return;
    const wasConnected = this.state === 'connected';
    socket.removeAllListeners();
    socket.io.removeAllListeners();
    socket.disconnect();
    this.state = 'stopped';
    this.connectedSince = null;
    if (wasConnected) this.options.onConnectionChange?.(false);
  }

  /** The feed as `GET /ingest/status` shows it. */
  status(): UpstreamFeedStatus {
    return {
      source: this.options.source,
      endpoint: endpointOf(this.options.url),
      state: this.state,
      connectedSince: this.connectedSince,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null || this.socket === null) return;
    const delay = reconnectDelayMs(
      this.reconnectAttempts,
      this.options.reconnectMinMs,
      this.options.reconnectMaxMs,
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const socket = this.socket;
      if (socket === null || socket.connected) return;
      this.reconnectAttempts += 1;
      this.state = 'connecting';
      this.options.onReconnectAttempt?.();
      socket.connect();
    }, delay);
    this.retryTimer.unref();
  }
}
