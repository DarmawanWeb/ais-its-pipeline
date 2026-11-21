import type { AisSource } from '@darmawanweb/ais-its-contracts/domain';
import type { AisRawReceivedV1 } from '@darmawanweb/ais-its-contracts/events';
import {
  ForbiddenError,
  InjectConfig,
  ServiceUnavailableError,
  ValidationFailedError,
} from '@darmawanweb/ais-its-nest';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { Injectable, Logger } from '@nestjs/common';

import {
  type AisRejectionCode,
  normalizeAisMessage,
} from '../../../shared/domain/normalize.js';
import type { IngestorConfig } from '../config.js';
import { IngestMetrics } from './ingest.metrics.js';
import { RawReportPublisher } from './raw-report.publisher.js';

/** Most messages one request or one `ais:data` event may carry (spec §13.2). */
export const MAX_INGEST_BATCH = 1000;

/** A message that was not accepted. */
export interface IngestError {
  /** Position in the submitted array (0 for a single message). */
  readonly index: number;
  readonly code: AisRejectionCode;
  readonly field: string | null;
  readonly message: string;
}

/** Outcome of an ingested batch: `202 { accepted, rejected, errors[] }`. */
export interface IngestResult {
  /** Valid reports stored in AIS_RAW (re-sent duplicates included: ingestion is idempotent). */
  readonly accepted: number;
  readonly rejected: number;
  readonly errors: readonly IngestError[];
}

/** Why a whole batch cannot be ingested. */
export type BatchProblem =
  | { readonly kind: 'invalid_payload'; readonly message: string }
  | { readonly kind: 'too_large'; readonly message: string };

/** The messages of a payload: one message object or an array of at most {@link MAX_INGEST_BATCH}. */
export function messagesOf(
  payload: unknown,
):
  | { ok: true; messages: readonly unknown[] }
  | { ok: false; problem: BatchProblem } {
  if (Array.isArray(payload)) {
    if (payload.length > MAX_INGEST_BATCH) {
      return {
        ok: false,
        problem: {
          kind: 'too_large',
          message: `At most ${MAX_INGEST_BATCH} messages per batch (got ${payload.length})`,
        },
      };
    }
    return { ok: true, messages: payload };
  }
  if (typeof payload === 'object' && payload !== null) {
    return { ok: true, messages: [payload] };
  }
  return {
    ok: false,
    problem: {
      kind: 'invalid_payload',
      message: 'Expected an AIS message object or an array of messages',
    },
  };
}

/**
 * Users may push reports only as platform administrators (manual testing);
 * machines use API keys with the `ais:ingest` scope, which the guard checks.
 */
export function assertMayIngest(principal: Principal): void {
  if (principal.kind === 'user' && !principal.isPlatformAdmin) {
    throw new ForbiddenError(
      'Only API keys with the ais:ingest scope (or platform administrators) may ingest AIS data',
    );
  }
}

/**
 * Normalizes reports from every feed (REST, pushers, upstream servers) and
 * publishes the valid ones to AIS_RAW. Batches (REST, pushers) are answered
 * once JetStream acknowledged them; upstream reports are fire-and-forget
 * with a bounded number of unacknowledged publishes.
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);
  /** Upstream reports published and not yet acknowledged. */
  private pending = 0;
  /** Last time a publish failure was logged per feed (log flood guard). */
  private readonly lastFailureLog = new Map<AisSource, number>();

  constructor(
    private readonly publisher: RawReportPublisher,
    private readonly metrics: IngestMetrics,
    @InjectConfig() private readonly config: IngestorConfig,
  ) {}

  /**
   * `POST /ingest/ais`: a batch pushed over REST by an API key (scope checked
   * by the guard) or a platform administrator (source `pusher`).
   *
   * @throws {ForbiddenError} `403` for users other than platform administrators
   */
  async ingestPushed(
    payload: unknown,
    principal: Principal,
  ): Promise<IngestResult> {
    assertMayIngest(principal);
    return this.ingestBatch(payload, 'pusher');
  }

  /**
   * Validates a REST or pusher batch and publishes its valid reports.
   *
   * @throws {ValidationFailedError} `400` when the payload is not a message or an array of ≤ 1000
   * @throws {ServiceUnavailableError} `503` when JetStream did not acknowledge (retry: duplicates are dropped)
   */
  async ingestBatch(
    payload: unknown,
    source: AisSource,
    receivedAt: Date = new Date(),
  ): Promise<IngestResult> {
    const batch = messagesOf(payload);
    if (!batch.ok) {
      throw new ValidationFailedError(
        [
          {
            field: 'body',
            message: batch.problem.message,
            code: batch.problem.kind,
          },
        ],
        batch.problem.message,
      );
    }
    const { reports, errors } = this.normalize(
      batch.messages,
      source,
      receivedAt,
    );
    if (reports.length > 0) {
      const verdicts = await this.publisher
        .publishMany(reports)
        .catch((error: unknown) => {
          this.metrics.count(source, 'failed', reports.length, receivedAt);
          throw new ServiceUnavailableError(
            'AIS reports could not be stored; retry the request (duplicates are dropped)',
            { cause: error },
          );
        });
      const duplicates = verdicts.filter((v) => v === 'duplicate').length;
      this.metrics.count(source, 'duplicate', duplicates, receivedAt);
      this.metrics.count(
        source,
        'published',
        reports.length - duplicates,
        receivedAt,
      );
    }
    return { accepted: reports.length, rejected: errors.length, errors };
  }

  /**
   * Handles one report of an upstream feed without waiting for JetStream:
   * dropped (and counted) while {@link IngestorConfig.INGEST_MAX_PENDING_PUBLISHES}
   * publishes are unacknowledged, so a stalled NATS cannot exhaust memory.
   */
  ingestStreamed(
    message: unknown,
    source: AisSource,
    receivedAt = new Date(),
  ): void {
    const { reports } = this.normalize([message], source, receivedAt);
    const report = reports[0];
    if (report === undefined) return;
    if (this.pending >= this.config.INGEST_MAX_PENDING_PUBLISHES) {
      this.metrics.count(source, 'dropped', 1, receivedAt);
      return;
    }
    this.pending += 1;
    this.metrics.instruments.pendingPublishes.set(this.pending);
    void this.publisher
      .publish(report)
      .then(
        (verdict) => {
          this.metrics.count(
            source,
            verdict === 'duplicate' ? 'duplicate' : 'published',
            1,
            receivedAt,
          );
        },
        (error: unknown) => {
          this.metrics.count(source, 'failed', 1, receivedAt);
          this.logFailure(source, error);
        },
      )
      .finally(() => {
        this.pending -= 1;
        this.metrics.instruments.pendingPublishes.set(this.pending);
      });
  }

  /** Upstream reports waiting for their publish ack. */
  pendingPublishes(): number {
    return this.pending;
  }

  /** Reports a feed's rejected batch (rate limit) in the metrics. */
  countRateLimited(source: AisSource, count: number): void {
    this.metrics.count(source, 'rate_limited', count);
  }

  private normalize(
    messages: readonly unknown[],
    source: AisSource,
    receivedAt: Date,
  ): { reports: AisRawReceivedV1[]; errors: IngestError[] } {
    const reports: AisRawReceivedV1[] = [];
    const errors: IngestError[] = [];
    messages.forEach((message, index) => {
      const result = normalizeAisMessage(message, { source, receivedAt });
      if (result.ok) {
        reports.push(result.report);
        return;
      }
      errors.push({ index, ...result.rejection });
      this.metrics.rejected(source, result.rejection.code);
    });
    this.metrics.count(source, 'rejected', errors.length, receivedAt);
    return { reports, errors };
  }

  private logFailure(source: AisSource, error: unknown): void {
    const now = Date.now();
    if (now - (this.lastFailureLog.get(source) ?? 0) < 10_000) return;
    this.lastFailureLog.set(source, now);
    this.logger.error(
      `Publishing ${source} reports to AIS_RAW failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
