import { ApiProperty } from '@nestjs/swagger';

import { AIS_REJECTION_CODES } from '../../../../shared/domain/normalize.js';
import type { IngestError, IngestResult } from '../ingest.service.js';

/** A rejected message. */
export class IngestErrorDto {
  @ApiProperty({
    description:
      'Position of the message in the submitted array (0 for a single message)',
    example: 3,
  })
  readonly index: number;

  @ApiProperty({ enum: AIS_REJECTION_CODES, example: 'POSITION_NOT_AVAILABLE' })
  readonly code: string;

  @ApiProperty({ type: String, nullable: true, example: 'message.data.lat' })
  readonly field: string | null;

  @ApiProperty({ example: 'lat 91 means not available' })
  readonly message: string;

  constructor(error: IngestError) {
    this.index = error.index;
    this.code = error.code;
    this.field = error.field;
    this.message = error.message;
  }
}

/** `202` answer of an ingested batch. */
export class IngestResultDto {
  @ApiProperty({
    description: 'Valid reports stored (re-sent duplicates included)',
    example: 998,
  })
  readonly accepted: number;

  @ApiProperty({ example: 2 })
  readonly rejected: number;

  @ApiProperty({ type: [IngestErrorDto] })
  readonly errors: IngestErrorDto[];

  constructor(result: IngestResult) {
    this.accepted = result.accepted;
    this.rejected = result.rejected;
    this.errors = result.errors.map((error) => new IngestErrorDto(error));
  }
}
