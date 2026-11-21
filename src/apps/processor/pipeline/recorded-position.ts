import type {
  AisSource,
  PredictedNavStatus,
} from '@darmawanweb/ais-its-contracts/domain';
import type { AisPositionRecordedV1 } from '@darmawanweb/ais-its-contracts/events';

/** A position as the processor records it (row of `positions`, latest state). */
export interface RecordedPosition {
  readonly mmsi: number;
  readonly time: Date;
  readonly source: AisSource;
  readonly lat: number;
  readonly lon: number;
  /** [kn] */
  readonly sog: number;
  /** [deg] */
  readonly cog: number;
  /** [deg], 511 = not available */
  readonly hdg: number;
  readonly navstatus: number;
  readonly predictedNavstatus: PredictedNavStatus;
  /** [m], `null` without coast geometry. */
  readonly coastDistanceM: number | null;
}

/** The `ais.position.recorded.v1` payload of `position` linked to the vessel's `previous` one. */
export function toPositionRecorded(
  position: RecordedPosition,
  previous: RecordedPosition | null,
): AisPositionRecordedV1 {
  return {
    mmsi: position.mmsi,
    time: position.time.toISOString(),
    source: position.source,
    lat: position.lat,
    lon: position.lon,
    sog: position.sog,
    cog: position.cog,
    hdg: position.hdg,
    navstatus: position.navstatus,
    predictedNavstatus: position.predictedNavstatus,
    coastDistanceM: position.coastDistanceM,
    previous:
      previous === null
        ? null
        : {
            time: previous.time.toISOString(),
            lat: previous.lat,
            lon: previous.lon,
            sog: previous.sog,
            cog: previous.cog,
            hdg: previous.hdg,
            navstatus: previous.navstatus,
            predictedNavstatus: previous.predictedNavstatus,
          },
  };
}
