import type {
  AisSource,
  PredictedNavStatus,
} from '@darmawanweb/ais-its-contracts/domain';

/** Vessel identity from the FLEET projection. */
export interface VesselIdentity {
  readonly id: string;
  readonly name: string;
  readonly typeCode: string | null;
}

/** The latest position of a vessel (query side). */
export interface VesselLatest {
  readonly mmsi: number;
  readonly time: Date;
  readonly lat: number;
  readonly lon: number;
  readonly sog: number;
  readonly cog: number;
  readonly hdg: number;
  readonly navstatus: number;
  readonly predictedNavstatus: PredictedNavStatus;
  readonly source: AisSource;
  readonly vessel: VesselIdentity | null;
}

/** Resolution of a track. */
export type TrackResolution = 'raw' | '1m';

/** A point of a track (raw position, or the last position of a minute). */
export interface TrackPoint {
  readonly time: Date;
  readonly lat: number;
  readonly lon: number;
  readonly sog: number;
  readonly cog: number;
  readonly hdg: number;
  readonly navstatus: number;
  readonly predictedNavstatus: PredictedNavStatus;
  readonly source: AisSource;
  /** `1m` only: reports in the minute, mean and maximum SOG [kn]. */
  readonly minute?: {
    readonly samples: number;
    readonly sogAvg: number;
    readonly sogMax: number;
  };
}

/** A vessel's track over a time range. */
export interface Track {
  readonly mmsi: number;
  readonly from: Date;
  readonly to: Date;
  readonly resolution: TrackResolution;
  /** Simplification tolerance [m], `null` when not simplified. */
  readonly simplifyM: number | null;
  /** More points matched than were returned: the newest are kept. */
  readonly truncated: boolean;
  /** When truncated: `to` of the request for the older rest of the range (1 ms before the first point). */
  readonly remainingTo: Date | null;
  readonly points: readonly TrackPoint[];
}
