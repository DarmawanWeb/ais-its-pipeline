import { AisSourceSchema } from '@darmawanweb/ais-its-contracts/domain';
import * as z from 'zod';

import type { RecordedPosition } from './recorded-position.js';

/** Valkey key of a vessel's last position (spec §13.2). */
export function lastPositionKey(mmsi: number): string {
  return `ais:last:${mmsi}`;
}

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
