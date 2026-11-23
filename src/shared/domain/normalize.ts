import {
  type AisSource,
  COG_NOT_AVAILABLE,
  HEADING_NOT_AVAILABLE,
  isValidMmsi,
  LATITUDE_NOT_AVAILABLE,
  LONGITUDE_NOT_AVAILABLE,
  SOG_NOT_AVAILABLE,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  type AisRawReceivedV1,
  AisRawReceivedV1Schema,
} from '@darmawanweb/ais-its-contracts/events';

/** How far a position time may lie ahead of the reception time, in ms (clock skew). */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * Default oldest accepted position time, relative to the reception [ms]:
 * 24 h, the `AIS_RAW` retention (spec §7.2) and the legacy 24 h track
 * window. Design default (`INGEST_MAX_POSITION_AGE_S`), not from a source.
 */
export const DEFAULT_MAX_POSITION_AGE_MS = 24 * 3_600_000;

/**
 * How the ingestor reads the upstream `utc` field (`AIS_UTC_MODE`, spec
 * §13.2: the provider's meaning is unconfirmed):
 *
 * - `legacy` (default, parity): seconds to subtract from the message
 *   timestamp ({@link legacyPositionTime});
 * - `itu`: the ITU-R M.1371 time stamp, the UTC second (0–59) at which the
 *   report was generated ({@link ituPositionTime}).
 */
export const AIS_UTC_MODES = ['legacy', 'itu'] as const;

/** A reading of `utc`, see {@link AIS_UTC_MODES}. */
export type AisUtcMode = (typeof AIS_UTC_MODES)[number];

/**
 * How far the reconstructed `itu` position time may lie after the message
 * timestamp [ms]: receiver clock behind the vessel's GNSS clock. Reports
 * delayed by more than 60 s minus this cannot be told apart from a report
 * one minute later (the time stamp carries the second only). Design
 * default, not from a source.
 */
export const ITU_TIME_STAMP_TOLERANCE_MS = 5000;

/** Longest `receiverPort` kept; longer values are dropped (informational field). */
export const MAX_RECEIVER_PORT_LENGTH = 128;

/** Why a message was rejected (stable codes, returned to pushers). */
export const AIS_REJECTION_CODES = [
  'INVALID_MESSAGE',
  'MISSING_FIELD',
  'INVALID_TYPE',
  'INVALID_MMSI',
  'POSITION_NOT_AVAILABLE',
  'OUT_OF_RANGE',
  'INVALID_TIMESTAMP',
  'FUTURE_TIMESTAMP',
  'STALE_TIMESTAMP',
] as const;

/** A rejection code. */
export type AisRejectionCode = (typeof AIS_REJECTION_CODES)[number];

/** The first problem found in a message. */
export interface AisRejection {
  readonly code: AisRejectionCode;
  /** Path of the offending field in the submitted message, `null` for the message itself. */
  readonly field: string | null;
  readonly message: string;
}

/**
 * Accepted wire formats: the legacy upstream `TimestampedAisMessage`
 * (`{ message: { data: {…}, port }, timestamp }`) and the flat normalized
 * format (`{ mmsi, navstatus, lat, lon, sog, cog, hdg, timestamp, utc? }`).
 */
export type AisMessageFormat = 'legacy' | 'normalized';

/** Result of {@link normalizeAisMessage}. */
export type AisNormalization =
  | {
      readonly ok: true;
      readonly format: AisMessageFormat;
      readonly report: AisRawReceivedV1;
      /**
       * Diagnostic of the `utc` meaning ({@link utcSecondLag}): seconds from
       * `utc` read as the ITU-R M.1371 time stamp to the timestamp's UTC
       * second, `null` without a `utc` of 0–59.
       */
      readonly utcSecondLagS: number | null;
    }
  | {
      readonly ok: false;
      readonly format: AisMessageFormat | null;
      readonly rejection: AisRejection;
    };

/** Where and when a message was received. */
export interface NormalizeContext {
  readonly source: AisSource;
  readonly receivedAt: Date;
  /** Default {@link MAX_FUTURE_SKEW_MS}. */
  readonly maxFutureSkewMs?: number | undefined;
  /** Oldest accepted position time before `receivedAt` [ms], default {@link DEFAULT_MAX_POSITION_AGE_MS}. */
  readonly maxPositionAgeMs?: number | undefined;
  /** Reading of `utc`, default `legacy` (spec §13.2). */
  readonly utcMode?: AisUtcMode | undefined;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Thrown inside the normalizer to stop at the first problem. */
class Rejected extends Error {
  constructor(readonly rejection: AisRejection) {
    super(rejection.message);
  }
}

function reject(
  code: AisRejectionCode,
  field: string | null,
  message: string,
): never {
  throw new Rejected({ code, field, message });
}

/** The fields of a message, wherever its format keeps them. */
interface RawFields {
  readonly format: AisMessageFormat;
  /** Field path prefix used in rejections (`message.data.` for legacy). */
  readonly prefix: string;
  readonly values: UnknownRecord;
  readonly timestamp: unknown;
  readonly timestampField: string;
  /** Legacy messages must carry `utc`; normalized ones may omit it (0). */
  readonly utcRequired: boolean;
  readonly aisType: unknown;
  readonly receiverPort: unknown;
}

function fieldsOf(input: unknown): RawFields {
  if (!isRecord(input)) {
    return reject('INVALID_MESSAGE', null, 'A message must be a JSON object');
  }
  if ('message' in input) {
    const message = input.message;
    if (!isRecord(message)) {
      return reject('INVALID_MESSAGE', 'message', 'message must be an object');
    }
    const data = message.data;
    if (!isRecord(data)) {
      return reject('MISSING_FIELD', 'message.data', 'message.data is missing');
    }
    return {
      format: 'legacy',
      prefix: 'message.data.',
      values: data,
      timestamp: input.timestamp,
      timestampField: 'timestamp',
      utcRequired: true,
      aisType: data.aistype,
      receiverPort: message.port,
    };
  }
  return {
    format: 'normalized',
    prefix: '',
    values: input,
    timestamp: input.timestamp,
    timestampField: 'timestamp',
    utcRequired: false,
    aisType: input.aisType,
    receiverPort: input.receiverPort,
  };
}

/** `null`/`undefined` count as missing (legacy `== null`). */
function present(fields: RawFields, name: string): unknown {
  const value = fields.values[name];
  if (value === undefined || value === null) {
    reject('MISSING_FIELD', `${fields.prefix}${name}`, `${name} is required`);
  }
  return value;
}

function finiteNumber(fields: RawFields, name: string): number {
  const value = present(fields, name);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return reject(
      'INVALID_TYPE',
      `${fields.prefix}${name}`,
      `${name} must be a finite number`,
    );
  }
  return value;
}

function inRange(
  fields: RawFields,
  name: string,
  value: number,
  ok: boolean,
  range: string,
): number {
  if (!ok) {
    reject(
      'OUT_OF_RANGE',
      `${fields.prefix}${name}`,
      `${name} must be ${range}`,
    );
  }
  return value;
}

/** MMSI as a number or a 9-digit string (the legacy upstream sends strings). */
function mmsiOf(fields: RawFields): number {
  const value = fields.values.mmsi;
  // Legacy `!mmsi`: absent, null, '' and 0 are missing.
  if (value === undefined || value === null || value === '' || value === 0) {
    return reject('MISSING_FIELD', `${fields.prefix}mmsi`, 'mmsi is required');
  }
  if (typeof value === 'number' && isValidMmsi(value)) return value;
  if (typeof value === 'string' && /^[1-9]\d{8}$/.test(value)) {
    return Number(value);
  }
  return reject(
    'INVALID_MMSI',
    `${fields.prefix}mmsi`,
    'mmsi must have exactly 9 digits',
  );
}

/** ISO-8601 without a zone designator, e.g. `2025-05-30 03:06:24` (read as UTC). */
const ZONELESS_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * Parses a message timestamp: epoch milliseconds or a date string as legacy
 * `new Date(timestamp)` does, except that a zone-less ISO date-time is read
 * as UTC (legacy read it in the server's zone, UTC in its containers).
 */
export function parseMessageTimestamp(value: unknown): Date | null {
  let date: Date;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    date = new Date(value);
  } else if (typeof value === 'string' && value.length > 0) {
    if (value.length > 64) return null;
    date = new Date(
      ZONELESS_DATE_TIME.test(value) ? `${value.replace(' ', 'T')}Z` : value,
    );
  } else {
    return null;
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Legacy position time: the message timestamp minus `utc` seconds.
 *
 * Exact port of `createOrUpdateAis` (`timestamp.setSeconds(timestamp.getSeconds() - utc)`),
 * including its truncation of fractional seconds (`setSeconds` drops the
 * fraction of `seconds − utc`); the UTC accessors are used so the result
 * does not depend on the process time zone. The provider's meaning of `utc`
 * is unconfirmed (it may be the ITU-R M.1371 time stamp, the UTC second of
 * the report) — parity is kept on purpose until it is confirmed; the
 * ITU reading is available as `AIS_UTC_MODE=itu` ({@link ituPositionTime}).
 *
 * @method data.ais_ingest_rules
 * @param timestamp - reception timestamp of the upstream message
 * @param utcSeconds - `data.utc` [s]
 * @returns position time
 * @see ../../../../../docs/METHODOLOGY.md#data.ais_ingest_rules
 * @see be-legacy/src/services/ais.service.ts (createOrUpdateAis)
 * @see itu-r-m1371-5, gpsd-aivdm-protocol (reference catalog)
 */
export function legacyPositionTime(timestamp: Date, utcSeconds: number): Date {
  const time = new Date(timestamp.getTime());
  time.setUTCSeconds(time.getUTCSeconds() - utcSeconds);
  return time;
}

/** Whether `utc` is an ITU-R M.1371 time stamp second (0–59; 60–63 are status codes). */
function isTimeStampSecond(utc: number): boolean {
  return Number.isInteger(utc) && utc >= 0 && utc <= 59;
}

/**
 * Position time when `utc` is the ITU-R M.1371 time stamp (`AIS_UTC_MODE=itu`):
 * the UTC second (0–59) at which the report was generated. The position
 * time is the latest whole second whose UTC second equals `utc`, no later
 * than the message timestamp plus {@link ITU_TIME_STAMP_TOLERANCE_MS}
 * (receiver clock behind the GNSS clock); a time stamp of 60 (not
 * available), 61 (manual input), 62 (dead reckoning) or 63 (positioning
 * system inoperative), or any other value, leaves the message timestamp.
 * This is the reconstruction of `data.ais_position_time` for the
 * unconfirmed meaning of `utc` (the legacy reading stays the default,
 * `data.ais_ingest_rules`).
 *
 * @method data.ais_position_time
 * @param timestamp - reception timestamp of the upstream message
 * @param utc - `data.utc`, time stamp second [s]
 * @param toleranceMs - clock tolerance [ms]
 * @returns position time (whole second), or `timestamp` without a time stamp second
 * @see ../../../../../docs/METHODOLOGY.md#data.ais_position_time
 * @see itu-r-m1371-5 (position report "Time stamp", reference catalog)
 * @see gpsd-aivdm-protocol (common navigation block bits 137-142, reference catalog)
 */
export function ituPositionTime(
  timestamp: Date,
  utc: number,
  toleranceMs: number = ITU_TIME_STAMP_TOLERANCE_MS,
): Date {
  if (!isTimeStampSecond(utc)) return new Date(timestamp.getTime());
  const latestSecond = Math.floor((timestamp.getTime() + toleranceMs) / 1000);
  const back = ((((latestSecond % 60) - utc) % 60) + 60) % 60;
  return new Date((latestSecond - back) * 1000);
}

/**
 * Diagnostic of the provider's `utc` meaning: `(second(timestamp) − utc) mod 60`
 * for a `utc` of 0–59, else `null`. When `utc` is the ITU-R M.1371 time stamp
 * the values gather at the reception delay (0–2 s); when it is an offset
 * (legacy reading) or a constant they spread over the whole minute
 * (metric `aisits_ais_utc_second_lag_seconds` of the ingestor).
 *
 * @method data.ais_position_time
 * @param timestamp - reception timestamp of the upstream message
 * @param utc - `data.utc`
 * @returns lag [s], 0–59, or `null`
 * @see ../../../../../docs/METHODOLOGY.md#data.ais_position_time
 */
export function utcSecondLag(timestamp: Date, utc: number): number | null {
  if (!isTimeStampSecond(utc)) return null;
  return (((timestamp.getUTCSeconds() - utc) % 60) + 60) % 60;
}

/** Epoch values below this are likely epoch seconds sent as milliseconds (before 1973-03-03). */
const EPOCH_SECONDS_HINT_LIMIT = 1e11;

function staleHint(fields: RawFields): string {
  return typeof fields.timestamp === 'number' &&
    fields.timestamp > 0 &&
    fields.timestamp < EPOCH_SECONDS_HINT_LIMIT
    ? ' (timestamps are epoch milliseconds; was it sent in seconds?)'
    : '';
}

/** The position time of a message and its `utc` diagnostic. */
interface PositionTime {
  readonly time: Date;
  readonly utcSecondLagS: number | null;
}

/**
 * Position time of a message: the timestamp read with `utc` ({@link AisUtcMode}),
 * accepted from {@link NormalizeContext.maxPositionAgeMs} before the reception
 * to {@link MAX_FUTURE_SKEW_MS} after it, never before 1970 (event ids are
 * UUID v7). A future "latest" position would hide every real one; a stale
 * one (often epoch seconds sent as milliseconds) would create hypertable
 * chunks in the past.
 *
 * @method data.ais_position_time (plausibility window; the legacy reading itself is {@link legacyPositionTime})
 * @see ../../../../../docs/METHODOLOGY.md#data.ais_position_time
 */
function positionTimeOf(
  fields: RawFields,
  context: NormalizeContext,
): PositionTime {
  const timestamp = parseMessageTimestamp(fields.timestamp);
  if (timestamp === null) {
    if (fields.timestamp === undefined || fields.timestamp === null) {
      return reject(
        'MISSING_FIELD',
        fields.timestampField,
        'timestamp is required',
      );
    }
    return reject(
      'INVALID_TIMESTAMP',
      fields.timestampField,
      'timestamp must be an ISO-8601 date-time or epoch milliseconds',
    );
  }
  let utc: number | null = null;
  if (fields.utcRequired || fields.values.utc !== undefined) {
    utc = finiteNumber(fields, 'utc');
  }
  const time =
    utc === null
      ? timestamp
      : (context.utcMode ?? 'legacy') === 'itu'
        ? ituPositionTime(timestamp, utc)
        : legacyPositionTime(timestamp, utc);
  if (Number.isNaN(time.getTime())) {
    return reject(
      'INVALID_TIMESTAMP',
      `${fields.prefix}utc`,
      'timestamp − utc is not a valid date',
    );
  }
  if (time.getTime() < 0) {
    return reject(
      'INVALID_TIMESTAMP',
      fields.timestampField,
      `the position time lies before 1970-01-01${staleHint(fields)}`,
    );
  }
  const ageMs = context.receivedAt.getTime() - time.getTime();
  if (-ageMs > (context.maxFutureSkewMs ?? MAX_FUTURE_SKEW_MS)) {
    return reject(
      'FUTURE_TIMESTAMP',
      fields.timestampField,
      'the position time lies in the future',
    );
  }
  const maxAgeMs = context.maxPositionAgeMs ?? DEFAULT_MAX_POSITION_AGE_MS;
  if (ageMs > maxAgeMs) {
    return reject(
      'STALE_TIMESTAMP',
      fields.timestampField,
      `the position time is more than ${Math.round(maxAgeMs / 1000)} s before its reception${staleHint(fields)}`,
    );
  }
  return {
    time,
    utcSecondLagS: utc === null ? null : utcSecondLag(timestamp, utc),
  };
}

/** Message field of a payload field, for a report that fails its schema. */
function messageFieldOf(
  fields: RawFields,
  path: readonly PropertyKey[],
): string | null {
  const [key] = path;
  if (typeof key !== 'string') return null;
  if (key === 'positionTime') return fields.timestampField;
  if (key === 'source' || key === 'receivedAt') return null;
  return `${fields.prefix}${key}`;
}

function aisTypeOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function receiverPortOf(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_RECEIVER_PORT_LENGTH
    ? value
    : null;
}

/**
 * Validates and normalizes one AIS position report into the
 * `ais.raw.received.v1` payload (spec §13.2):
 *
 * - legacy `TimestampedAisMessage` or the flat normalized format;
 * - drops messages with a missing `mmsi`, `navstatus`, `lat`, `lon`, `sog`,
 *   `cog`, `hdg` (legacy `== null` check), timestamp or (legacy format) `utc`;
 * - `mmsi` must have exactly 9 digits (number or digit string);
 * - `lat` = 91 / `lon` = 181 mean "not available" and are rejected, as is
 *   any value outside `lat` ∈ [−90, 90], `lon` ∈ [−180, 180], `navstatus`
 *   ∈ 0..15, `sog` ∈ [0, 102.3] kn, `cog` ∈ [0, 360]°, `hdg` ∈ [0, 360)° or 511;
 * - position time = timestamp − `utc` seconds ({@link legacyPositionTime},
 *   spec §13.2), or the ITU-R M.1371 time stamp reading with
 *   `AIS_UTC_MODE=itu` ({@link ituPositionTime}); accepted from
 *   `maxPositionAgeMs` (default 24 h, `STALE_TIMESTAMP`) before the
 *   reception to {@link MAX_FUTURE_SKEW_MS} after it (`FUTURE_TIMESTAMP`),
 *   never before 1970 (`INVALID_TIMESTAMP`);
 * - the result is checked against the `ais.raw.received.v1` schema, so an
 *   unpublishable report is rejected on its own (`INVALID_MESSAGE`).
 *
 * `valid` is ignored as in legacy; `aistype` and `port` are kept when well-formed.
 *
 * @method data.ais_ingest_rules
 * @method navstatus.ais_codes (code ranges and "not available" values: navstatus 0..15, HDG 511, SOG 102.3 kn, COG 360°)
 * @returns the payload, or the first problem found
 * @see ../../../../../docs/METHODOLOGY.md#data.ais_ingest_rules
 * @see ../../../../../docs/METHODOLOGY.md#navstatus.ais_codes
 * @see be-legacy/src/services/ais.service.ts (createOrUpdateAis), be-legacy/src/types/ais.type.ts
 */
export function normalizeAisMessage(
  input: unknown,
  context: NormalizeContext,
): AisNormalization {
  let format: AisMessageFormat | null = null;
  try {
    const fields = fieldsOf(input);
    format = fields.format;
    const mmsi = mmsiOf(fields);
    // Presence first, in the legacy order, then types and ranges.
    for (const name of ['navstatus', 'lat', 'lon', 'sog', 'cog', 'hdg']) {
      present(fields, name);
    }
    const navstatus = finiteNumber(fields, 'navstatus');
    inRange(
      fields,
      'navstatus',
      navstatus,
      Number.isInteger(navstatus) && navstatus >= 0 && navstatus <= 15,
      'an integer 0..15',
    );
    const lat = finiteNumber(fields, 'lat');
    if (lat === LATITUDE_NOT_AVAILABLE) {
      reject(
        'POSITION_NOT_AVAILABLE',
        `${fields.prefix}lat`,
        'lat 91 means not available',
      );
    }
    inRange(fields, 'lat', lat, lat >= -90 && lat <= 90, 'in [-90, 90]');
    const lon = finiteNumber(fields, 'lon');
    if (lon === LONGITUDE_NOT_AVAILABLE) {
      reject(
        'POSITION_NOT_AVAILABLE',
        `${fields.prefix}lon`,
        'lon 181 means not available',
      );
    }
    inRange(fields, 'lon', lon, lon >= -180 && lon <= 180, 'in [-180, 180]');
    const sog = finiteNumber(fields, 'sog');
    inRange(
      fields,
      'sog',
      sog,
      sog >= 0 && sog <= SOG_NOT_AVAILABLE,
      `in [0, ${SOG_NOT_AVAILABLE}] kn`,
    );
    const cog = finiteNumber(fields, 'cog');
    inRange(
      fields,
      'cog',
      cog,
      cog >= 0 && cog <= COG_NOT_AVAILABLE,
      `in [0, ${COG_NOT_AVAILABLE}] degrees`,
    );
    const hdg = finiteNumber(fields, 'hdg');
    inRange(
      fields,
      'hdg',
      hdg,
      (hdg >= 0 && hdg < 360) || hdg === HEADING_NOT_AVAILABLE,
      `in [0, 360) degrees or ${HEADING_NOT_AVAILABLE}`,
    );
    const positionTime = positionTimeOf(fields, context);
    // The payload must be publishable: a report its contract schema refuses
    // would fail the whole batch at publish time instead of being listed.
    const parsed = AisRawReceivedV1Schema.safeParse({
      source: context.source,
      receivedAt: context.receivedAt.toISOString(),
      positionTime: positionTime.time.toISOString(),
      mmsi,
      navstatus,
      lat,
      lon,
      sog,
      cog,
      hdg,
      aisType: aisTypeOf(fields.aisType),
      receiverPort: receiverPortOf(fields.receiverPort),
    } satisfies AisRawReceivedV1);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      return reject(
        'INVALID_MESSAGE',
        messageFieldOf(fields, issue?.path ?? []),
        `The report does not match ais.raw.received.v1: ${issue === undefined ? 'invalid' : `${issue.path.join('.')}: ${issue.message}`}`,
      );
    }
    return {
      ok: true,
      format,
      report: parsed.data,
      utcSecondLagS: positionTime.utcSecondLagS,
    };
  } catch (error) {
    if (error instanceof Rejected) {
      return { ok: false, format, rejection: error.rejection };
    }
    throw error;
  }
}

/**
 * `Nats-Msg-Id` of a raw report: `<mmsi>:<positionTime>:<source>`, so
 * JetStream drops a report re-sent by the same feed within its 2-minute
 * duplicate window (spec §13.2).
 */
export function rawReportMessageId(report: AisRawReceivedV1): string {
  return `${report.mmsi}:${report.positionTime}:${report.source}`;
}
