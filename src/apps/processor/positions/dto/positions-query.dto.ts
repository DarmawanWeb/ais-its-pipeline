import {
  isValidMmsi,
  MMSI_MAX,
  MMSI_MIN,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  BBoxQueryDto,
  TimeRangeQueryDto,
} from '@darmawanweb/ais-its-nest/http';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';

import type { TrackResolution } from '../positions.model.js';
import {
  LATEST_DEFAULT_LIMIT,
  LATEST_MAX_LIMIT,
  LATEST_MAX_MMSIS,
} from '../positions.service.js';

const ISO_8601 = { strict: true, strictSeparator: true } as const;

/** An MMSI in a query list: exactly nine digits, as the `:mmsi` path parameter. */
const MMSI_DIGITS = /^[0-9]{9}$/;

/**
 * `mmsi=a,b,c` (or repeated `mmsi=a&mmsi=b`) as MMSIs, duplicates dropped,
 * in request order. An item that is not nine digits stays a string, so the
 * validators below reject the list (`400 VALIDATION_FAILED`, field `mmsi`).
 */
export function parseMmsiList(value: unknown): unknown {
  if (value === undefined) return undefined;
  const values: readonly unknown[] = Array.isArray(value)
    ? (value as unknown[])
    : [value];
  const items = values.flatMap((item): unknown[] =>
    typeof item === 'string' ? item.split(',') : [item],
  );
  const parsed = items.map((item): unknown => {
    const text = typeof item === 'string' ? item.trim() : item;
    return typeof text === 'string' && MMSI_DIGITS.test(text)
      ? Number(text)
      : text;
  });
  return [...new Set(parsed)];
}

/**
 * A valid MMSI (contracts `isValidMmsi`): one field error `code: 'isMmsi'`
 * per value, as the kit's `@MmsiParam()` reports for a path segment.
 */
function IsMmsi(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isMmsi',
      validator: {
        validate: (value: unknown) => isValidMmsi(value),
        defaultMessage: () => 'each mmsi must be a 9-digit MMSI',
      },
    },
    options,
  );
}

/** `GET /ais/latest?bbox&since&limit&mmsi`. */
export class LatestQueryDto extends BBoxQueryDto {
  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Only vessels whose latest position is at or after this time (default: 24 h ago; with `mmsi`, no default)',
  })
  @IsOptional()
  @IsISO8601(ISO_8601)
  readonly since?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: LATEST_MAX_LIMIT,
    default: LATEST_DEFAULT_LIMIT,
    type: 'integer',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LATEST_MAX_LIMIT)
  readonly limit: number = LATEST_DEFAULT_LIMIT;

  @ApiPropertyOptional({
    type: String,
    pattern: `^[0-9]{9}(,[0-9]{9}){0,${LATEST_MAX_MMSIS - 1}}$`,
    example: '525005223,525005224',
    description: `Only these vessels: up to ${LATEST_MAX_MMSIS} comma-separated MMSIs (batch lookup, e.g. "last seen" of a vessel list). Vessels without a recorded position are omitted; without \`since\` their latest positions are returned whatever their age.`,
  })
  @IsOptional()
  @Transform(({ value }) => parseMmsiList(value))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(LATEST_MAX_MMSIS)
  @IsMmsi({ each: true })
  readonly mmsi?: number[];
}

/** `?from&to&resolution&simplify` of the track endpoints (default last 24 h). */
export class TrackQueryDto extends TimeRangeQueryDto {
  @ApiPropertyOptional({
    enum: ['raw', '1m'],
    default: 'raw',
    description:
      'raw: every recorded position (range ≤ 7 days); 1m: the last position of each minute with its sample count and mean / maximum SOG (range ≤ 90 days)',
  })
  @IsOptional()
  @IsIn(['raw', '1m'])
  readonly resolution: TrackResolution = 'raw';

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 100_000,
    description:
      'Douglas–Peucker tolerance in metres, 0 = none (method geo.track_simplification; applied after the 100 000-point limit)',
    example: 25,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100_000)
  readonly simplify?: number;
}

/** `GET /ais/pairs/track?mmsi1&mmsi2&from&to&resolution&simplify`. */
export class PairTrackQueryDto extends TrackQueryDto {
  @ApiProperty({
    example: 525005223,
    minimum: MMSI_MIN,
    maximum: MMSI_MAX,
    type: 'integer',
  })
  @Type(() => Number)
  @IsInt()
  @Min(MMSI_MIN)
  @Max(MMSI_MAX)
  readonly mmsi1!: number;

  @ApiProperty({
    example: 525005224,
    minimum: MMSI_MIN,
    maximum: MMSI_MAX,
    type: 'integer',
  })
  @Type(() => Number)
  @IsInt()
  @Min(MMSI_MIN)
  @Max(MMSI_MAX)
  readonly mmsi2!: number;
}
