import { UuidV7Schema } from '@darmawanweb/ais-its-contracts/domain';
import { describe, expect, it } from 'vitest';

import { deterministicUuidV7, positionEventId } from './event-id.js';

describe('deterministicUuidV7', () => {
  it('is a valid UUID v7 carrying the timestamp', () => {
    const time = Date.parse('2026-01-01T00:00:00.123Z');
    const id = deterministicUuidV7(time, 'key');

    expect(UuidV7Schema.safeParse(id).success).toBe(true);
    expect(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(time);
  });

  it('is deterministic per key and differs between keys', () => {
    const time = 1_700_000_000_000;
    expect(deterministicUuidV7(time, 'a')).toBe(deterministicUuidV7(time, 'a'));
    expect(deterministicUuidV7(time, 'a')).not.toBe(
      deterministicUuidV7(time, 'b'),
    );
  });

  it('refuses timestamps outside the 48-bit range', () => {
    expect(() => deterministicUuidV7(-1, 'a')).toThrow(RangeError);
    expect(() => deterministicUuidV7(2 ** 48, 'a')).toThrow(RangeError);
    expect(() => deterministicUuidV7(1.5, 'a')).toThrow(RangeError);
  });
});

describe('positionEventId', () => {
  it('identifies a position by mmsi and time', () => {
    const time = new Date('2026-01-01T00:00:00.000Z');
    expect(positionEventId(525005223, time)).toBe(
      positionEventId(525005223, new Date(time)),
    );
    expect(positionEventId(525005223, time)).not.toBe(
      positionEventId(525005224, time),
    );
  });
});
