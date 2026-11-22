import { AisSourceSchema } from '@darmawanweb/ais-its-contracts/domain';
import * as z from 'zod';

import type { RecordedPosition } from './recorded-position.js';

/** Valkey key of a vessel's last position (spec §13.2). */
export function lastPositionKey(mmsi: number): string {
  return `ais:last:${mmsi}`;
}

/**
 * Hash field holding the position time in epoch milliseconds, compared by
 * the monotonic save script and by the cache revalidation.
 */
export const LAST_POSITION_TIME_MS_FIELD = 'ms';

const finite = z.string().transform((value, ctx) => {
  const number = Number(value);
  if (value === '' || !Number.isFinite(number)) {
    ctx.addIssue({ code: 'custom', message: 'not a finite number' });
    return z.NEVER;
  }
  return number;
});

const LastPositionHashSchema = z.object({
  mmsi: finite,
  time: z.iso.datetime().transform((value) => new Date(value)),
  source: AisSourceSchema,
  lat: finite,
  lon: finite,
  sog: finite,
  cog: finite,
  hdg: finite,
  navstatus: finite,
  pred: z.enum(['0', '1']).transform((value) => (value === '1' ? 1 : 0)),
  /** Empty = no coast geometry. */
  coast: z.union([z.literal('').transform(() => null), finite]),
});

/** Hash fields of `ais:last:<mmsi>` (strings, as Valkey stores them). */
export function encodeLastPosition(
  position: RecordedPosition,
): Record<string, string> {
  return {
    mmsi: String(position.mmsi),
    time: position.time.toISOString(),
    [LAST_POSITION_TIME_MS_FIELD]: String(position.time.getTime()),
    source: position.source,
    lat: String(position.lat),
    lon: String(position.lon),
    sog: String(position.sog),
    cog: String(position.cog),
    hdg: String(position.hdg),
    navstatus: String(position.navstatus),
    pred: String(position.predictedNavstatus),
    coast:
      position.coastDistanceM === null ? '' : String(position.coastDistanceM),
  };
}

/**
 * Parses an `ais:last:<mmsi>` hash; `null` for an empty or malformed hash
 * (the store then falls back to the database).
 */
export function decodeLastPosition(
  hash: Readonly<Record<string, string>>,
): RecordedPosition | null {
  const parsed = LastPositionHashSchema.safeParse(hash);
  if (!parsed.success) return null;
  const { pred, coast, ...rest } = parsed.data;
  return { ...rest, predictedNavstatus: pred, coastDistanceM: coast };
}

/**
 * Lua script of the monotonic save: writes the hash only when it holds no
 * position or an older one (`ms` field), so a late or repeated save never
 * moves a vessel's last position back; refreshes the TTL when it writes or
 * holds the same position. `KEYS[1]` = key, `ARGV[1]` = TTL [s], `ARGV[2]` =
 * position time [ms], `ARGV[3..]` = field/value pairs. Returns 1 when
 * written, 0 when a newer (or the same) position is stored.
 */
export const SAVE_LAST_POSITION_SCRIPT = `
local stored = tonumber(redis.call('HGET', KEYS[1], '${LAST_POSITION_TIME_MS_FIELD}'))
local incoming = tonumber(ARGV[2])
if stored ~= nil and stored >= incoming then
  if stored == incoming then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return 0
end
redis.call('HSET', KEYS[1], unpack(ARGV, 3))
redis.call('EXPIRE', KEYS[1], ARGV[1])
return 1
`;
