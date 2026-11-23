import { AIS_SOURCES } from '@darmawanweb/ais-its-contracts/domain';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type {
  Track,
  TrackPoint,
  VesselIdentity,
  VesselLatest,
} from '../positions.model.js';

/** Vessel identity from the fleet service (FLEET projection). */
export class VesselRefDto {
  @ApiProperty({ format: 'uuid' })
  readonly id: string;

  @ApiProperty({ example: 'KM Sinar Bahari' })
  readonly name: string;

  @ApiProperty({ type: String, nullable: true, example: 'bulk_carrier' })
  readonly typeCode: string | null;

  constructor(vessel: VesselIdentity) {
    this.id = vessel.id;
    this.name = vessel.name;
    this.typeCode = vessel.typeCode;
  }
}

/** `VesselLatestDto` (spec §13.2): the latest position of a vessel. */
export class VesselLatestDto {
  @ApiProperty({ example: 525005223 })
  readonly mmsi: number;

  @ApiProperty({ format: 'date-time', description: 'Position time' })
  readonly time: string;

  @ApiProperty({ example: -7.2 })
  readonly lat: number;

  @ApiProperty({ example: 112.73 })
  readonly lon: number;

  @ApiProperty({ description: 'Speed over ground [kn]', example: 8.5 })
  readonly sog: number;

  @ApiProperty({ description: 'Course over ground [deg]', example: 91 })
  readonly cog: number;

  @ApiProperty({
    description: 'True heading [deg], 511 = not available',
    example: 90,
  })
  readonly hdg: number;

  @ApiProperty({ minimum: 0, maximum: 15, example: 0 })
  readonly navstatus: number;

  @ApiProperty({
    enum: [0, 1],
    description: '1 = predicted at anchor (navstatus.prediction)',
  })
  readonly predictedNavstatus: 0 | 1;

  @ApiProperty({ enum: AIS_SOURCES })
  readonly source: string;

  @ApiPropertyOptional({
    type: VesselRefDto,
    description: 'Present when the fleet service knows the MMSI',
  })
  readonly vessel?: VesselRefDto;

  constructor(latest: VesselLatest) {
    this.mmsi = latest.mmsi;
    this.time = latest.time.toISOString();
    this.lat = latest.lat;
    this.lon = latest.lon;
    this.sog = latest.sog;
    this.cog = latest.cog;
    this.hdg = latest.hdg;
    this.navstatus = latest.navstatus;
    this.predictedNavstatus = latest.predictedNavstatus;
    this.source = latest.source;
    if (latest.vessel !== null) this.vessel = new VesselRefDto(latest.vessel);
  }
}

/** A track point: a raw position, or (resolution `1m`) the last position of a minute. */
export class TrackPointDto {
  @ApiProperty({
    format: 'date-time',
    description: 'Position time (1m: start of the minute)',
  })
  readonly time: string;

  @ApiProperty()
  readonly lat: number;

  @ApiProperty()
  readonly lon: number;

  @ApiProperty({ description: '[kn] (1m: last of the minute)' })
  readonly sog: number;

  @ApiProperty({ description: '[deg]' })
  readonly cog: number;

  @ApiProperty({ description: '[deg], 511 = not available' })
  readonly hdg: number;

  @ApiProperty()
  readonly navstatus: number;

  @ApiProperty({ enum: [0, 1] })
  readonly predictedNavstatus: 0 | 1;

  @ApiProperty({ enum: AIS_SOURCES })
  readonly source: string;

  @ApiPropertyOptional({ description: '1m only: reports in the minute' })
  readonly samples?: number;

  @ApiPropertyOptional({ description: '1m only: mean SOG of the minute [kn]' })
  readonly sogAvg?: number;

  @ApiPropertyOptional({
    description: '1m only: maximum SOG of the minute [kn]',
  })
  readonly sogMax?: number;

  constructor(point: TrackPoint) {
    this.time = point.time.toISOString();
    this.lat = point.lat;
    this.lon = point.lon;
    this.sog = point.sog;
    this.cog = point.cog;
    this.hdg = point.hdg;
    this.navstatus = point.navstatus;
    this.predictedNavstatus = point.predictedNavstatus;
    this.source = point.source;
    if (point.minute !== undefined) {
      this.samples = point.minute.samples;
      this.sogAvg = point.minute.sogAvg;
      this.sogMax = point.minute.sogMax;
    }
  }
}

/** A vessel's track. */
export class TrackDto {
  @ApiProperty({ example: 525005223 })
  readonly mmsi: number;

  @ApiProperty({ format: 'date-time' })
  readonly from: string;

  @ApiProperty({ format: 'date-time' })
  readonly to: string;

  @ApiProperty({ enum: ['raw', '1m'] })
  readonly resolution: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Simplification tolerance [m], null = not simplified',
  })
  readonly simplifyM: number | null;

  @ApiProperty({
    description:
      'More than 100 000 points matched: the newest 100 000 are returned (the track still ends at `to`); fetch the older rest with `to` = `remainingTo`, or use resolution 1m',
  })
  readonly truncated: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When truncated: the `to` of the request for the older rest of the range (1 ms before the first returned point); null when the track is complete',
  })
  readonly remainingTo: string | null;

  @ApiProperty({ type: [TrackPointDto] })
  readonly points: TrackPointDto[];

  constructor(track: Track) {
    this.mmsi = track.mmsi;
    this.from = track.from.toISOString();
    this.to = track.to.toISOString();
    this.resolution = track.resolution;
    this.simplifyM = track.simplifyM;
    this.truncated = track.truncated;
    this.remainingTo = track.remainingTo?.toISOString() ?? null;
    this.points = track.points.map((point) => new TrackPointDto(point));
  }
}

/** Tracks of two vessels over the same range, resolution and simplification. */
export class PairTrackDto {
  @ApiProperty({ format: 'date-time' })
  readonly from: string;

  @ApiProperty({ format: 'date-time' })
  readonly to: string;

  @ApiProperty({ type: [TrackDto], description: '[mmsi1, mmsi2]' })
  readonly tracks: TrackDto[];

  constructor(from: Date, to: Date, tracks: readonly Track[]) {
    this.from = from.toISOString();
    this.to = to.toISOString();
    this.tracks = tracks.map((track) => new TrackDto(track));
  }
}
