import { describe, expect, it } from 'vitest';

import {
  decodeLastPosition,
  encodeLastPosition,
  LAST_POSITION_TIME_MS_FIELD,
  lastPositionKey,
  SAVE_LAST_POSITION_SCRIPT,
} from './last-position.codec.js';
import type { RecordedPosition } from './recorded-position.js';

const position: RecordedPosition = {
  mmsi: 525005223,
  time: new Date('2026-01-01T00:00:00.123Z'),
  source: 'batam',
  lat: -7.123456789012345,
  lon: 112.98765432109876,
  sog: 0.1,
  cog: 359.9,
  hdg: 511,
  navstatus: 1,
  predictedNavstatus: 1,
  coastDistanceM: 1234.5678901234,
};

describe('last position codec', () => {
  it('uses the key ais:last:<mmsi>', () => {
    expect(lastPositionKey(525005223)).toBe('ais:last:525005223');
  });

  it('round-trips every field exactly', () => {
    expect(decodeLastPosition(encodeLastPosition(position))).toEqual(position);
    const noCoast = {
      ...position,
      coastDistanceM: null,
      predictedNavstatus: 0 as const,
    };
    expect(decodeLastPosition(encodeLastPosition(noCoast))).toEqual(noCoast);
  });

  it('stores the position time in epoch milliseconds for the monotonic save', () => {
    expect(encodeLastPosition(position)).toMatchObject({
      time: '2026-01-01T00:00:00.123Z',
      [LAST_POSITION_TIME_MS_FIELD]: String(Date.UTC(2026, 0, 1, 0, 0, 0, 123)),
    });
    // The script compares that field and writes the hash only when it is older.
    expect(SAVE_LAST_POSITION_SCRIPT).toContain(
      `redis.call('HGET', KEYS[1], '${LAST_POSITION_TIME_MS_FIELD}')`,
    );
    expect(SAVE_LAST_POSITION_SCRIPT).toContain('stored >= incoming');
  });

  it('returns null for empty or malformed hashes', () => {
    expect(decodeLastPosition({})).toBeNull();
    expect(
      decodeLastPosition({ ...encodeLastPosition(position), lat: 'x' }),
    ).toBeNull();
    expect(
      decodeLastPosition({ ...encodeLastPosition(position), source: 'radar' }),
    ).toBeNull();
  });
});
