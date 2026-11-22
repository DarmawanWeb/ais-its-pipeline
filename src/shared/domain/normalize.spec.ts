import { AisRawReceivedV1Schema } from '@darmawanweb/ais-its-contracts/events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyMovement, type MovementClass } from './movement.js';
import {
  type AisUtcMode,
  DEFAULT_MAX_POSITION_AGE_MS,
  ituPositionTime,
  legacyPositionTime,
  MAX_FUTURE_SKEW_MS,
  normalizeAisMessage,
  parseMessageTimestamp,
  rawReportMessageId,
  utcSecondLag,
} from './normalize.js';

const receivedAt = new Date('2025-05-30T03:06:30.000Z');

/** A legacy upstream `TimestampedAisMessage` (be-legacy/src/types/ais.type.ts). */
function legacyMessage(
  data: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    message: {
      data: {
        valid: true,
        aistype: 1,
        mmsi: '525005141',
        navstatus: 0,
        lon: 116.05734,
        lat: -8.747773333333333,
        cog: 0,
        sog: 0.1,
        hdg: 511,
        utc: 24,
        ...data,
      },
      port: 'COM3',
    },
    timestamp: '2025-05-30T03:06:24.343Z',
    ...extra,
  };
}

function normalizedMessage(
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mmsi: 525005223,
    navstatus: 1,
    lat: -7.2,
    lon: 112.73,
    sog: 0.2,
    cog: 10,
    hdg: 12,
    timestamp: '2025-05-30T03:06:00.000Z',
    ...fields,
  };
}

function rejectionOf(input: unknown) {
  const result = normalizeAisMessage(input, { source: 'pusher', receivedAt });
  if (result.ok) throw new Error('expected a rejection');
  return result.rejection;
}

describe('normalizeAisMessage', () => {
  it('normalizes a legacy upstream message (positionTime = timestamp − utc s)', () => {
    const result = normalizeAisMessage(legacyMessage(), {
      source: 'primary',
      receivedAt,
    });

    expect(result).toEqual({
      ok: true,
      format: 'legacy',
      report: {
        source: 'primary',
        receivedAt: '2025-05-30T03:06:30.000Z',
        positionTime: '2025-05-30T03:06:00.343Z',
        mmsi: 525005141,
        navstatus: 0,
        lat: -8.747773333333333,
        lon: 116.05734,
        sog: 0.1,
        cog: 0,
        hdg: 511,
        aisType: 1,
        receiverPort: 'COM3',
      },
      utcSecondLagS: 0,
    });
    if (result.ok) {
      expect(AisRawReceivedV1Schema.safeParse(result.report).success).toBe(
        true,
      );
    }
  });

  it('normalizes the flat format, utc optional', () => {
    const result = normalizeAisMessage(normalizedMessage(), {
      source: 'pusher',
      receivedAt,
    });

    expect(result).toMatchObject({
      ok: true,
      format: 'normalized',
      report: {
        mmsi: 525005223,
        positionTime: '2025-05-30T03:06:00.000Z',
        aisType: null,
        receiverPort: null,
      },
    });
  });

  it('accepts epoch milliseconds and applies utc in the flat format', () => {
    const result = normalizeAisMessage(
      normalizedMessage({
        timestamp: Date.parse('2025-05-30T03:06:10.000Z'),
        utc: 10,
        aisType: 18,
      }),
      { source: 'pusher', receivedAt },
    );

    expect(result).toMatchObject({
      ok: true,
      report: { positionTime: '2025-05-30T03:06:00.000Z', aisType: 18 },
    });
  });

  it('ignores `valid` as legacy did', () => {
    expect(
      normalizeAisMessage(legacyMessage({ valid: false }), {
        source: 'batam',
        receivedAt,
      }).ok,
    ).toBe(true);
  });

  it.each([
    ['mmsi', undefined],
    ['mmsi', ''],
    ['mmsi', 0],
    ['navstatus', null],
    ['lat', undefined],
    ['lon', null],
    ['sog', undefined],
    ['cog', undefined],
    ['hdg', null],
    ['utc', undefined],
  ])('drops a legacy message without %s (%s)', (field, value) => {
    expect(rejectionOf(legacyMessage({ [field]: value }))).toEqual({
      code: 'MISSING_FIELD',
      field: `message.data.${field}`,
      message: `${field} is required`,
    });
  });

  it('requires the timestamp and message.data', () => {
    expect(
      rejectionOf(legacyMessage({}, { timestamp: undefined })),
    ).toMatchObject({ code: 'MISSING_FIELD', field: 'timestamp' });
    expect(
      rejectionOf({ message: { port: 'x' }, timestamp: 'x' }),
    ).toMatchObject({ code: 'MISSING_FIELD', field: 'message.data' });
  });

  it.each([
    ['525005', 'INVALID_MMSI'],
    ['5250051410', 'INVALID_MMSI'],
    ['052500514', 'INVALID_MMSI'],
    ['52500514a', 'INVALID_MMSI'],
    [52500514, 'INVALID_MMSI'],
    [525005141.5, 'INVALID_MMSI'],
  ])('rejects the MMSI %s', (mmsi, code) => {
    expect(rejectionOf(normalizedMessage({ mmsi }))).toMatchObject({
      code,
      field: 'mmsi',
    });
  });

  it('rejects not-available positions (lat 91, lon 181)', () => {
    expect(rejectionOf(legacyMessage({ lat: 91 }))).toMatchObject({
      code: 'POSITION_NOT_AVAILABLE',
      field: 'message.data.lat',
    });
    expect(rejectionOf(legacyMessage({ lon: 181 }))).toMatchObject({
      code: 'POSITION_NOT_AVAILABLE',
      field: 'message.data.lon',
    });
  });

  it.each([
    ['lat', 90.5],
    ['lat', -90.01],
    ['lon', -180.5],
    ['lon', 180.1],
    ['navstatus', 16],
    ['navstatus', 1.5],
    ['navstatus', -1],
    ['sog', -0.1],
    ['sog', 102.4],
    ['cog', 360.5],
    ['cog', -1],
    ['hdg', 360],
    ['hdg', 512],
    ['hdg', -2],
  ])('rejects %s = %s as out of range', (field, value) => {
    expect(rejectionOf(normalizedMessage({ [field]: value }))).toMatchObject({
      code: 'OUT_OF_RANGE',
      field,
    });
  });

  it.each([
    ['lat', 90],
    ['lon', -180],
    ['sog', 102.3],
    ['cog', 360],
    ['hdg', 511],
    ['hdg', 359.9],
    ['navstatus', 15],
  ])('accepts the boundary %s = %s', (field, value) => {
    expect(
      normalizeAisMessage(normalizedMessage({ [field]: value }), {
        source: 'pusher',
        receivedAt,
      }).ok,
    ).toBe(true);
  });

  it('rejects non-numeric values', () => {
    expect(rejectionOf(normalizedMessage({ lat: '-7.2' }))).toMatchObject({
      code: 'INVALID_TYPE',
      field: 'lat',
    });
    expect(rejectionOf(normalizedMessage({ sog: Number.NaN }))).toMatchObject({
      code: 'INVALID_TYPE',
      field: 'sog',
    });
  });

  it('rejects invalid and future timestamps', () => {
    expect(
      rejectionOf(normalizedMessage({ timestamp: 'yesterday' })),
    ).toMatchObject({ code: 'INVALID_TIMESTAMP', field: 'timestamp' });
    const future = new Date(receivedAt.getTime() + MAX_FUTURE_SKEW_MS + 1);
    expect(
      rejectionOf(normalizedMessage({ timestamp: future.toISOString() })),
    ).toMatchObject({ code: 'FUTURE_TIMESTAMP' });
    const limit = new Date(receivedAt.getTime() + MAX_FUTURE_SKEW_MS);
    expect(
      normalizeAisMessage(
        normalizedMessage({ timestamp: limit.toISOString() }),
        {
          source: 'pusher',
          receivedAt,
        },
      ).ok,
    ).toBe(true);
  });

  it.each([null, 'text', 42, [legacyMessage()], { message: 'x' }])(
    'rejects %j as an invalid message',
    (input) => {
      expect(rejectionOf(input).code).toBe('INVALID_MESSAGE');
    },
  );
});

describe('normalizeAisMessage: position time plausibility', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['year 1', '0001-01-01T00:00:00Z'],
    ['before 1970', '1960-06-01T00:00:00Z'],
    ['a negative year', '-000001-01-01T00:00:00Z'],
  ])(
    'rejects a position time before 1970 (%s): no UUID v7 event id exists for it',
    (_label, timestamp) => {
      expect(rejectionOf(normalizedMessage({ timestamp }))).toMatchObject({
        code: 'INVALID_TIMESTAMP',
        field: 'timestamp',
      });
    },
  );

  it('rejects epoch seconds sent as milliseconds (January 1970) as stale, with a hint', () => {
    const rejection = rejectionOf(normalizedMessage({ timestamp: 1700000000 }));
    expect(rejection).toMatchObject({
      code: 'STALE_TIMESTAMP',
      field: 'timestamp',
    });
    expect(rejection.message).toContain('epoch milliseconds');
  });

  it('accepts position times up to the maximum age before the reception (default 24 h)', () => {
    const oldest = new Date(receivedAt.getTime() - DEFAULT_MAX_POSITION_AGE_MS);
    expect(
      normalizeAisMessage(
        normalizedMessage({ timestamp: oldest.toISOString() }),
        {
          source: 'pusher',
          receivedAt,
        },
      ).ok,
    ).toBe(true);
    const older = new Date(oldest.getTime() - 1);
    expect(
      rejectionOf(normalizedMessage({ timestamp: older.toISOString() })),
    ).toMatchObject({ code: 'STALE_TIMESTAMP' });
  });

  it('applies a configured maximum age', () => {
    const twoHoursAgo = new Date(receivedAt.getTime() - 2 * 3_600_000);
    const result = normalizeAisMessage(
      normalizedMessage({ timestamp: twoHoursAgo.toISOString() }),
      { source: 'pusher', receivedAt, maxPositionAgeMs: 3_600_000 },
    );
    expect(result).toMatchObject({
      ok: false,
      rejection: { code: 'STALE_TIMESTAMP' },
    });
  });

  it('drops an aistype that is no safe integer instead of refusing the report', () => {
    const result = normalizeAisMessage(
      normalizedMessage({ aisType: 2 ** 60 }),
      {
        source: 'pusher',
        receivedAt,
      },
    );
    expect(result).toMatchObject({ ok: true, report: { aisType: null } });
  });

  it('lists a report its contract schema refuses as INVALID_MESSAGE instead of failing at publish time', () => {
    const issue = {
      code: 'custom' as const,
      path: ['positionTime'],
      message: 'Invalid ISO datetime',
      input: undefined,
    };
    vi.spyOn(AisRawReceivedV1Schema, 'safeParse').mockReturnValueOnce({
      success: false,
      error: { issues: [issue] },
    } as unknown as ReturnType<typeof AisRawReceivedV1Schema.safeParse>);

    expect(rejectionOf(normalizedMessage())).toEqual({
      code: 'INVALID_MESSAGE',
      field: 'timestamp',
      message:
        'The report does not match ais.raw.received.v1: positionTime: Invalid ISO datetime',
    });
  });

  it('returns the utc diagnostic of the report (lag of utc read as the ITU time stamp)', () => {
    // timestamp 03:06:24.343, utc 24: the lag is 0 s.
    expect(
      normalizeAisMessage(legacyMessage(), { source: 'primary', receivedAt }),
    ).toMatchObject({ ok: true, utcSecondLagS: 0 });
    expect(
      normalizeAisMessage(normalizedMessage(), {
        source: 'pusher',
        receivedAt,
      }),
    ).toMatchObject({ ok: true, utcSecondLagS: null });
  });
});

describe('ituPositionTime (AIS_UTC_MODE=itu)', () => {
  const at = (iso: string) => new Date(iso);

  it.each([
    [
      'received 500 ms after the report',
      '2025-05-30T10:00:10.500Z',
      10,
      '2025-05-30T10:00:10.000Z',
    ],
    [
      'received in the next second',
      '2025-05-30T10:00:11.200Z',
      10,
      '2025-05-30T10:00:10.000Z',
    ],
    [
      'across the minute',
      '2025-05-30T10:00:00.300Z',
      59,
      '2025-05-30T09:59:59.000Z',
    ],
    [
      'across the hour and day',
      '2025-05-31T00:00:01.000Z',
      58,
      '2025-05-30T23:59:58.000Z',
    ],
    [
      'receiver clock 100 ms behind',
      '2025-05-30T10:00:09.900Z',
      10,
      '2025-05-30T10:00:10.000Z',
    ],
    [
      'receiver clock 5 s behind (tolerance)',
      '2025-05-30T10:00:05.000Z',
      10,
      '2025-05-30T10:00:10.000Z',
    ],
    [
      'beyond the tolerance: the previous minute',
      '2025-05-30T10:00:04.000Z',
      10,
      '2025-05-30T09:59:10.000Z',
    ],
    ['delayed 50 s', '2025-05-30T10:00:50.000Z', 0, '2025-05-30T10:00:00.000Z'],
  ])(
    'reconstructs the time stamp second: %s',
    (_label, timestamp, utc, expected) => {
      expect(ituPositionTime(at(timestamp), utc).toISOString()).toBe(expected);
    },
  );

  it.each([60, 61, 62, 63, 5.5, -1, 64])(
    'keeps the message timestamp for utc %s (no time stamp second)',
    (utc) => {
      const timestamp = at('2025-05-30T10:00:10.500Z');
      expect(ituPositionTime(timestamp, utc).getTime()).toBe(
        timestamp.getTime(),
      );
    },
  );

  it('is selected by the normalizer context', () => {
    const result = normalizeAisMessage(legacyMessage(), {
      source: 'primary',
      receivedAt,
      utcMode: 'itu',
    });
    // timestamp 03:06:24.343, utc 24 → 03:06:24 (legacy: 03:06:00.343).
    expect(result).toMatchObject({
      ok: true,
      report: { positionTime: '2025-05-30T03:06:24.000Z' },
    });
  });
});

describe('utcSecondLag', () => {
  it.each([
    ['2025-05-30T03:06:24.343Z', 24, 0],
    ['2025-05-30T03:06:26.000Z', 24, 2],
    ['2025-05-30T03:07:00.300Z', 59, 1],
    ['2025-05-30T03:06:10.000Z', 30, 40],
    ['2025-05-30T03:06:10.000Z', 60, null],
    ['2025-05-30T03:06:10.000Z', 2.5, null],
  ])('(%s, utc %s) → %s', (timestamp, utc, expected) => {
    expect(utcSecondLag(new Date(timestamp), utc)).toBe(expected);
  });
});

/**
 * The reviewer's regression scenario (spec §13.2 open question): one vessel
 * reporting every 10 s for an hour, received 50–500 ms later, with `utc`
 * the ITU-R M.1371 time stamp (the UTC second of the report).
 */
describe('position time of consecutive 10 s reports when utc is the ITU time stamp', () => {
  const start = Date.UTC(2026, 10, 22, 10, 0, 0);

  function simulate(utcMode: AisUtcMode) {
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    let latest: { timeMs: number; lat: number; lon: number } | null = null;
    const kinds: Record<MovementClass['kind'], number> = {
      first: 0,
      advance: 0,
      stationary: 0,
      same_time: 0,
      out_of_order: 0,
    };
    const times: string[] = [];
    for (let i = 0; i < 360; i += 1) {
      const generatedMs = start + i * 10_000;
      const timestamp = new Date(generatedMs + 50 + random() * 450);
      const result = normalizeAisMessage(
        legacyMessage(
          {
            utc: new Date(generatedMs).getUTCSeconds(),
            lat: -7.2 + i * 0.0005,
            lon: 112.7,
          },
          { timestamp: timestamp.toISOString() },
        ),
        { source: 'primary', receivedAt: timestamp, utcMode },
      );
      if (!result.ok) throw new Error(result.rejection.message);
      const fix = {
        timeMs: Date.parse(result.report.positionTime),
        lat: result.report.lat,
        lon: result.report.lon,
      };
      const movement = classifyMovement(latest, fix, 0.1);
      kinds[movement.kind] += 1;
      if (movement.kind === 'first' || movement.kind === 'advance') {
        latest = fix;
        times.push(result.report.positionTime);
      }
    }
    return { kinds, times };
  }

  it('legacy reading (timestamp − utc s): times collapse to the start of each minute and most reports become out of order', () => {
    const { kinds } = simulate('legacy');
    expect(kinds.first + kinds.advance + kinds.out_of_order).toBe(360);
    expect(kinds.out_of_order).toBeGreaterThan(150);
  });

  it('itu reading: every report advances, at the second it was generated', () => {
    const { kinds, times } = simulate('itu');
    expect(kinds).toEqual({
      first: 1,
      advance: 359,
      stationary: 0,
      same_time: 0,
      out_of_order: 0,
    });
    expect(times).toEqual(
      Array.from({ length: 360 }, (_, i) =>
        new Date(start + i * 10_000).toISOString(),
      ),
    );
  });
});

describe('legacyPositionTime', () => {
  it.each([0, 1, 24, 59, 60, 63, 5.7, 30.2, 75])(
    'matches legacy setSeconds(getSeconds() − %s)',
    (utc) => {
      for (const timestamp of [
        '2025-05-30T03:06:24.343Z',
        '2025-05-30T03:06:03.000Z',
        '2025-12-31T23:59:59.999Z',
      ]) {
        const legacy = new Date(timestamp);
        legacy.setSeconds(legacy.getSeconds() - utc);

        expect(legacyPositionTime(new Date(timestamp), utc).getTime()).toBe(
          legacy.getTime(),
        );
      }
    },
  );
});

describe('parseMessageTimestamp', () => {
  it('reads zone-less date-times as UTC', () => {
    expect(parseMessageTimestamp('2025-05-30 03:06:24')?.toISOString()).toBe(
      '2025-05-30T03:06:24.000Z',
    );
    expect(parseMessageTimestamp('2025-05-30T03:06:24.5')?.toISOString()).toBe(
      '2025-05-30T03:06:24.500Z',
    );
  });

  it('keeps explicit offsets', () => {
    expect(
      parseMessageTimestamp('2025-05-30T10:06:24+07:00')?.toISOString(),
    ).toBe('2025-05-30T03:06:24.000Z');
  });

  it.each([undefined, '', 'x'.repeat(65), Number.POSITIVE_INFINITY, {}])(
    'returns null for %j',
    (value) => {
      expect(parseMessageTimestamp(value)).toBeNull();
    },
  );
});

describe('rawReportMessageId', () => {
  it('is <mmsi>:<positionTime>:<source> (spec §13.2)', () => {
    const result = normalizeAisMessage(legacyMessage(), {
      source: 'batam',
      receivedAt,
    });
    if (!result.ok) throw new Error('expected a report');

    expect(rawReportMessageId(result.report)).toBe(
      '525005141:2025-05-30T03:06:00.343Z:batam',
    );
  });
});
