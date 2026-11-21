import { AisRawReceivedV1Schema } from '@darmawanweb/ais-its-contracts/events';
import { describe, expect, it } from 'vitest';

import {
  legacyPositionTime,
  MAX_FUTURE_SKEW_MS,
  normalizeAisMessage,
  parseMessageTimestamp,
  rawReportMessageId,
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
