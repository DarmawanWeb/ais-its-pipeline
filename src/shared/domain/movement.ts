import { legacyHaversineDistance } from '@darmawanweb/ais-its-contracts/domain';

/**
 * Minimum movement from the latest recorded position for a newer report to
 * be recorded [m] (`AIS_DEDUP_MIN_DISTANCE_M`).
 */
// SOURCE: thesis — needs citation
export const DEFAULT_DEDUP_MIN_DISTANCE_M = 0.1;

/** A timed fix (position time in epoch ms). */
export interface TimedFix {
  readonly timeMs: number;
  readonly lat: number;
  readonly lon: number;
}

/** How a report relates to the latest recorded position of its vessel. */
export type MovementClass =
  /** The vessel has no recorded position: record it. */
  | { readonly kind: 'first' }
  /** Newer and moved at least the threshold: record it as the new latest. */
  | { readonly kind: 'advance'; readonly distanceM: number }
  /** Newer but moved less than the threshold: skip it (legacy duplicate filter). */
  | { readonly kind: 'stationary'; readonly distanceM: number }
  /**
   * Same position time as the latest: a redelivery or the same report
   * from another feed (`samePosition`), or a conflicting one.
   */
  | {
      readonly kind: 'same_time';
      readonly samePosition: boolean;
      readonly distanceM: number;
    }
  /** Older than the latest: store it, never let it replace the latest state. */
  | { readonly kind: 'out_of_order' };

/**
 * Classifies a report against the vessel's latest recorded position.
 *
 * The duplicate-movement filter of legacy `createOrUpdateAis` skipped a
 * report that moved less than 0.1 m (haversine, R = 3438 nm × 1852) from
 * the stored reference position; v2 compares with the **latest** position
 * (legacy compared with the oldest one — spec §15.1) and only for reports
 * newer than it. Reports with an older position time are out of order: they
 * are stored but neither become the latest position nor link back to it as
 * `previous` (spec §13.2).
 *
 * @method data.ais_ingest_rules
 * @param latest - latest recorded fix of the vessel, `null` when none
 * @param report - incoming fix
 * @param minDistanceM - threshold [m] (default 0.1)
 * @see ../../../../../docs/METHODOLOGY.md#data.ais_ingest_rules
 * @see ../../../../../docs/METHODOLOGY.md#geo.haversine_distance
 * @see be-legacy/src/services/ais.service.ts (createOrUpdateAis), be-legacy/src/utils/cii/speed-calculation.ts (calculateDistance)
 */
export function classifyMovement(
  latest: TimedFix | null,
  report: TimedFix,
  minDistanceM: number = DEFAULT_DEDUP_MIN_DISTANCE_M,
): MovementClass {
  if (latest === null) return { kind: 'first' };
  if (report.timeMs < latest.timeMs) return { kind: 'out_of_order' };
  // Legacy argument order: calculateDistance(storedPosition, newPosition).
  const distanceM = legacyHaversineDistance(latest, report).meters;
  if (report.timeMs === latest.timeMs) {
    return {
      kind: 'same_time',
      samePosition: distanceM < minDistanceM,
      distanceM,
    };
  }
  return distanceM < minDistanceM
    ? { kind: 'stationary', distanceM }
    : { kind: 'advance', distanceM };
}
