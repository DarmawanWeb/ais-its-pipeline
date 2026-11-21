import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Documentation-only shapes of the accepted wire formats: the body is
// validated report by report by the domain normalizer (partial acceptance
// with per-message errors), not by class-validator.

/** `message.data` of the legacy upstream format. */
export class LegacyAisDataDto {
  @ApiPropertyOptional({ description: 'Ignored (legacy parity)' })
  readonly valid?: boolean;

  @ApiPropertyOptional({ description: 'AIS message type', example: 1 })
  readonly aistype?: number;

  @ApiProperty({
    description: '9-digit MMSI (string or number)',
    example: '525005141',
    oneOf: [{ type: 'string' }, { type: 'integer' }],
  })
  readonly mmsi!: string;

  @ApiProperty({ minimum: 0, maximum: 15, example: 0 })
  readonly navstatus!: number;

  @ApiProperty({
    minimum: -180,
    maximum: 180,
    description: '181 = not available (rejected)',
    example: 116.05734,
  })
  readonly lon!: number;

  @ApiProperty({
    minimum: -90,
    maximum: 90,
    description: '91 = not available (rejected)',
    example: -8.7477733,
  })
  readonly lat!: number;

  @ApiProperty({
    minimum: 0,
    maximum: 360,
    description: 'Course over ground [deg]',
    example: 0,
  })
  readonly cog!: number;

  @ApiProperty({
    minimum: 0,
    maximum: 102.3,
    description: 'Speed over ground [kn]',
    example: 0.1,
  })
  readonly sog!: number;

  @ApiProperty({
    description: 'True heading [deg] 0..359, 511 = not available',
    example: 511,
  })
  readonly hdg!: number;

  @ApiProperty({
    description:
      'Seconds subtracted from `timestamp` for the position time (legacy parity)',
    example: 24,
  })
  readonly utc!: number;
}

/** `message` of the legacy upstream format. */
export class LegacyAisEnvelopeDto {
  @ApiProperty({ type: LegacyAisDataDto })
  readonly data!: LegacyAisDataDto;

  @ApiPropertyOptional({ description: 'Receiver port', example: 'COM3' })
  readonly port?: string;
}

/** Legacy `TimestampedAisMessage` (upstream `messageFromServer`, pusher `ais:data`). */
export class LegacyAisMessageDto {
  @ApiProperty({ type: LegacyAisEnvelopeDto })
  readonly message!: LegacyAisEnvelopeDto;

  @ApiProperty({ format: 'date-time', example: '2025-05-30T03:06:24.343Z' })
  readonly timestamp!: string;
}

/** The flat normalized format. */
export class NormalizedAisMessageDto {
  @ApiProperty({ description: '9-digit MMSI', example: 525005223 })
  readonly mmsi!: number;

  @ApiProperty({ minimum: 0, maximum: 15, example: 0 })
  readonly navstatus!: number;

  @ApiProperty({ minimum: -90, maximum: 90, example: -7.2 })
  readonly lat!: number;

  @ApiProperty({ minimum: -180, maximum: 180, example: 112.73 })
  readonly lon!: number;

  @ApiProperty({ minimum: 0, maximum: 102.3, example: 8.5 })
  readonly sog!: number;

  @ApiProperty({ minimum: 0, maximum: 360, example: 91 })
  readonly cog!: number;

  @ApiProperty({ example: 90 })
  readonly hdg!: number;

  @ApiProperty({
    description: 'ISO-8601 date-time or epoch milliseconds',
    example: '2026-11-21T08:30:00.000Z',
    oneOf: [{ type: 'string', format: 'date-time' }, { type: 'integer' }],
  })
  readonly timestamp!: string;

  @ApiPropertyOptional({
    description: 'Seconds subtracted from `timestamp` (default 0)',
    example: 0,
  })
  readonly utc?: number;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 1 })
  readonly aisType?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  readonly receiverPort?: string | null;
}
