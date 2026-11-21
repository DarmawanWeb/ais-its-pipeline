import { MMSI_MAX, MMSI_MIN } from '@darmawanweb/ais-its-contracts/domain';
import {
  BBoxQueryDto,
  TimeRangeQueryDto,
} from '@darmawanweb/ais-its-nest/http';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

import {
  LATEST_DEFAULT_LIMIT,
  LATEST_MAX_LIMIT,
} from '../positions.service.js';

const ISO_8601 = { strict: true, strictSeparator: true } as const;

/** `GET /ais/latest?bbox&since&limit`. */
export class LatestQueryDto extends BBoxQueryDto {
  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Only vessels whose latest position is at or after this time (default: 24 h ago)',
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
}

/** `GET /ais/vessels/:mmsi/track?from&to&resolution&simplify` (default last 24 h). */
export class TrackQueryDto extends TimeRangeQueryDto {
  @ApiPropertyOptional({
    enum: ['raw', '1m'],
    default: 'raw',
    description: 'raw ≤ 7 days, 1m ≤ 90 days',
  })
  @IsOptional()
  @IsIn(['raw', '1m'])
  readonly resolution: 'raw' | '1m' = 'raw';

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 100_000,
    description: 'Douglas–Peucker tolerance in metres (0 = none)',
    example: 25,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100_000)
  readonly simplify?: number;
}

/** `GET /ais/pairs/track?mmsi1&mmsi2&from&to`. */
export class PairTrackQueryDto extends TimeRangeQueryDto {
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

/** `:mmsi` path parameter (9 digits). */
export class MmsiParamDto {
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
  readonly mmsi!: number;
}
