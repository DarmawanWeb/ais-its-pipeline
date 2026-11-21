import {
  HEADING_NOT_AVAILABLE,
  PREDICTED_NAV_STATUS,
  type PredictedNavStatus,
} from '@darmawanweb/ais-its-contracts/domain';

/** The motion fields the prediction reads from a report. */
export interface MotionSample {
  /** Speed over ground [kn]. */
  readonly sog: number;
  /** Course over ground [deg]. */
  readonly cog: number;
  /** True heading [deg], 511 = not available. */
  readonly hdg: number;
}

/**
 * Thresholds of the "predicted at anchor" heuristic. Values of the thesis
 * MVP without an external source.
 */
export const NAV_STATUS_PREDICTION = Object.freeze({
  // SOURCE: thesis — needs citation
  /** Mean SOG of the previous and current report below which a vessel may be at anchor [kn]. */
  maxMeanSogKn: 0.4,
  // SOURCE: thesis — needs citation
  /** Mean |COG − HDG| below which a vessel may be at anchor [deg]. */
  maxMeanCogHeadingDiffDeg: 10,
  // SOURCE: thesis — needs citation
  /** Minimum distance from the coast polygon of a vessel at anchor [m]. */
  minCoastDistanceM: 210,
});

/**
 * Predicted navigational status, exact port of legacy
 * `calculatePredictedNavStatus(current, old, minDistance)`:
 *
 * 1 (at anchor) when there is no previous report, or when the mean SOG
 * `|SOG_o + SOG_c| / 2 < 0.4 kn`, the mean course/heading difference
 * `||COG_o − HDG_o| + |COG_c − HDG_c|| / 2 < 10°` (no 360° wrap, as legacy)
 * or the current heading is 511 (not available), and the coast distance is
 * `> 210 m`; otherwise 0. A `NaN` distance predicts 0 and `Infinity` (no
 * coast geometry) passes the distance test, as in legacy.
 *
 * @method navstatus.prediction
 * @param current - current report (sog [kn], cog [deg], hdg [deg])
 * @param previous - previous report of the vessel (see {@link predictNavStatus})
 * @param coastDistanceM - distance to the coast polygon [m] (`geo.coast_distance`)
 * @returns 1 = predicted at anchor, 0 = not at anchor
 * @see ../../../../../docs/METHODOLOGY.md#navstatus.prediction
 * @see be-legacy/src/services/predict-navstatus.service.ts (calculatePredictedNavStatus)
 * @see harati-mokhtari-2007-ais-reliability, pallotta-2013-tread (reference catalog)
 */
export function calculatePredictedNavStatus(
  current: MotionSample,
  previous: MotionSample | null | undefined,
  coastDistanceM: number,
): PredictedNavStatus {
  if (!previous) return PREDICTED_NAV_STATUS.AT_ANCHOR;
  const meanSog = Math.abs(previous.sog + current.sog) / 2;
  const previousDiff = Math.abs(previous.cog - previous.hdg);
  const currentDiff = Math.abs(current.cog - current.hdg);
  const meanDiff = Math.abs(previousDiff + currentDiff) / 2;
  if (
    meanSog < NAV_STATUS_PREDICTION.maxMeanSogKn &&
    (meanDiff < NAV_STATUS_PREDICTION.maxMeanCogHeadingDiffDeg ||
      current.hdg === HEADING_NOT_AVAILABLE) &&
    coastDistanceM > NAV_STATUS_PREDICTION.minCoastDistanceM
  ) {
    return PREDICTED_NAV_STATUS.AT_ANCHOR;
  }
  return PREDICTED_NAV_STATUS.NOT_AT_ANCHOR;
}

/**
 * The prediction as the legacy pipeline applied it: a vessel's first report
 * is its own previous report (legacy "CASE 1: Kapal baru" passed the current
 * message twice), later reports use the latest recorded position.
 *
 * @method navstatus.prediction
 * @see ../../../../../docs/METHODOLOGY.md#navstatus.prediction
 * @see be-legacy/src/services/ais.service.ts (createOrUpdateAis)
 */
export function predictNavStatus(
  current: MotionSample,
  latest: MotionSample | null,
  coastDistanceM: number,
): PredictedNavStatus {
  return calculatePredictedNavStatus(
    current,
    latest ?? current,
    coastDistanceM,
  );
}
