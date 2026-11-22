import { createHash } from 'node:crypto';

/** Largest 48-bit Unix millisecond timestamp a UUID v7 can carry. */
const MAX_UUID_V7_MS = 2 ** 48 - 1;

/**
 * Whether a UUID v7 can carry `timeMs` (whole milliseconds from 1970-01-01
 * to the year 10889): the range of the deterministic event ids.
 */
export function isUuidV7Time(timeMs: number): boolean {
  return Number.isInteger(timeMs) && timeMs >= 0 && timeMs <= MAX_UUID_V7_MS;
}

/**
 * Deterministic UUID v7 for a fact identified by `key` at `timeMs`: the
 * 48-bit millisecond timestamp of RFC 9562 §5.7 followed by version, variant
 * and 74 bits of SHA-256(`key`). Re-processing the same fact yields the same
 * id, so the envelope id (and `Nats-Msg-Id`) of a re-published event matches
 * the first publication and consumers deduplicating by id stay idempotent.
 *
 * @throws {RangeError} when `timeMs` is outside the UUID v7 range
 */
export function deterministicUuidV7(timeMs: number, key: string): string {
  if (!isUuidV7Time(timeMs)) {
    throw new RangeError(`Timestamp out of the UUID v7 range: ${timeMs}`);
  }
  const bytes = createHash('sha256').update(key).digest().subarray(0, 16);
  let ms = timeMs;
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f); // version 7
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // RFC 9562 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Envelope id of the `ais.position.recorded.v1` event of a vessel's position. */
export function positionEventId(mmsi: number, time: Date): string {
  return deterministicUuidV7(
    time.getTime(),
    `ais.position.recorded.v1:${mmsi}:${time.toISOString()}`,
  );
}
