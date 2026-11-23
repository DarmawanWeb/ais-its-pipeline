import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';

import {
  LatestQueryDto,
  PairTrackQueryDto,
  parseMmsiList,
} from './positions-query.dto.js';

function validate<T extends object>(
  type: new () => T,
  query: Record<string, unknown>,
) {
  const dto = plainToInstance(type, query);
  const errors = validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, fields: errors.map((error) => error.property) };
}

describe('parseMmsiList', () => {
  it('reads comma-separated and repeated lists, drops duplicates, keeps the order', () => {
    expect(parseMmsiList('525005223,525005224, 525005223')).toEqual([
      525005223, 525005224,
    ]);
    expect(parseMmsiList(['525005223', '525005225,525005224'])).toEqual([
      525005223, 525005225, 525005224,
    ]);
    expect(parseMmsiList(undefined)).toBeUndefined();
  });

  it('leaves items that are not nine digits as they are (rejected by the validators)', () => {
    expect(parseMmsiList('0525005223,52500522,abc,')).toEqual([
      '0525005223',
      '52500522',
      'abc',
      '',
    ]);
  });
});

describe('LatestQueryDto.mmsi', () => {
  it('accepts up to 100 MMSIs', () => {
    const list = Array.from({ length: 100 }, (_, i) => 525_000_000 + i);
    const { dto, fields } = validate(LatestQueryDto, { mmsi: list.join(',') });
    expect(fields).toEqual([]);
    expect(dto.mmsi).toEqual(list);
  });

  it.each([
    ['an empty list', ''],
    ['a malformed MMSI', '525005223,5250052'],
    ['a leading zero', '052500522'],
    [
      'more than 100 MMSIs',
      Array.from({ length: 101 }, (_, i) => 525_000_000 + i).join(','),
    ],
  ])('rejects %s on the field mmsi with one error', (_, mmsi) => {
    const dto = plainToInstance(LatestQueryDto, { mmsi });
    const errors = validateSync(dto);
    expect(errors.map((error) => error.property)).toEqual(['mmsi']);
    expect(Object.keys(errors[0]?.constraints ?? {})).toHaveLength(1);
  });
});

describe('PairTrackQueryDto', () => {
  it('takes the resolution and simplification of the vessel track', () => {
    const { dto, fields } = validate(PairTrackQueryDto, {
      mmsi1: '525005223',
      mmsi2: '525005224',
      resolution: '1m',
      simplify: '25',
    });
    expect(fields).toEqual([]);
    expect(dto).toMatchObject({ resolution: '1m', simplify: 25 });
  });

  it('defaults to raw and rejects unknown resolutions and negative tolerances', () => {
    const pair = { mmsi1: '525005223', mmsi2: '525005224' };
    expect(validate(PairTrackQueryDto, pair).dto.resolution).toBe('raw');
    expect(
      validate(PairTrackQueryDto, { ...pair, resolution: '5m', simplify: -1 })
        .fields,
    ).toEqual(['resolution', 'simplify']);
  });
});
