import {
  DomainError,
  ForbiddenError,
  UnauthorizedError,
} from '@darmawanweb/ais-its-nest';
import {
  type ApiKeyPrincipal,
  ApiKeyVerifier,
} from '@darmawanweb/ais-its-nest/auth';
import { Injectable } from '@nestjs/common';

/** API-key scope a pusher needs (spec §8.4). */
export const PUSHER_SCOPE = 'ais:ingest';

/** The handshake data of a socket that the authenticator reads. */
export interface PusherHandshake {
  readonly auth: Readonly<Record<string, unknown>>;
}

/** `connect_error` data sent to a refused pusher (`err.data`). */
export interface ConnectErrorData {
  readonly code: string;
  readonly status: number;
  readonly detail: string | undefined;
}

/** A handshake failure in the shape socket.io sends to the client (`message` + `data`). */
export class PusherConnectError extends Error {
  readonly data: ConnectErrorData;

  constructor(error: unknown) {
    const data: ConnectErrorData =
      error instanceof DomainError
        ? { code: error.code, status: error.status, detail: error.detail }
        : { code: 'INTERNAL_ERROR', status: 500, detail: undefined };
    super(data.detail ?? data.code);
    this.data = data;
  }
}

/**
 * Authenticates pushers: the handshake `auth: { apiKey }` is introspected
 * through the platform (cached 60 s by the kit's {@link ApiKeyVerifier}) and
 * must carry the `ais:ingest` scope. Keys are re-checked on every message,
 * so a revoked key stops being accepted within the cache lifetime.
 */
@Injectable()
export class PusherAuthenticator {
  constructor(private readonly apiKeys: ApiKeyVerifier) {}

  /**
   * @throws {UnauthorizedError} `401 INVALID_API_KEY` without a valid key
   * @throws {ForbiddenError} `403 INSUFFICIENT_SCOPE` without the `ais:ingest` scope
   * @throws {ServiceUnavailableError} `503` when the introspection is unavailable
   */
  async authenticate(handshake: PusherHandshake): Promise<ApiKeyPrincipal> {
    const key = handshake.auth.apiKey;
    if (typeof key !== 'string' || key.length === 0) {
      throw new UnauthorizedError(
        'Send the API key in the handshake: auth: { apiKey }',
        {
          code: 'INVALID_API_KEY',
          challenge: 'ApiKey',
        },
      );
    }
    const principal = await this.apiKeys.verify(key);
    if (!principal.hasScope(PUSHER_SCOPE)) {
      throw new ForbiddenError(`The API key lacks the scope ${PUSHER_SCOPE}`, {
        code: 'INSUFFICIENT_SCOPE',
        extra: { missingScopes: [PUSHER_SCOPE] },
      });
    }
    return principal;
  }
}
