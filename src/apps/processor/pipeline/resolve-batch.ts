import { predictNavStatus } from '../../../shared/domain/navstatus.js';
import type { RecordedPosition } from './recorded-position.js';

/** A row of a write batch, as the pipeline decided it from its in-memory state. */
export interface PositionRow {
  readonly position: RecordedPosition;
  /**
   * `true` for a candidate new latest position (first or advancing report),
   * `false` for an out-of-order report (stored only).
   */
  readonly latest: boolean;
  /**
   * The vessel's latest position the decision assumed (the event's
   * `previous`); `null` for a first report and for out-of-order rows.
   */
  readonly assumedPrevious: RecordedPosition | null;
}

/** What the write did with a row. */
export type RowOutcome =
  /** Became the vessel's latest position; its event is in the outbox. */
  | 'recorded'
  /** A candidate not newer than the stored latest position: stored as an out-of-order row. */
  | 'demoted'
  /** An out-of-order row: stored only. */
  | 'stored';

/** The resolution of one row. */
export interface RowResolution {
  readonly outcome: RowOutcome;
  /**
   * `true` when the stored latest position contradicted the decision's
   * assumption (stale in-memory or Valkey state): the caller reloads it.
   */
  readonly stale: boolean;
  /** The vessel's latest position after the batch (Valkey refresh); `null` for out-of-order rows. */
  readonly latest: RecordedPosition | null;
}

/** A recorded position with the position it links back to. */
export interface PositionRecord {
  readonly position: RecordedPosition;
  readonly previous: RecordedPosition | null;
}

/** The writes of a batch, resolved against the stored latest positions. */
export interface BatchResolution {
  /** Rows of `positions`, in input order (predicted navstatus resolved). */
  readonly rows: readonly RecordedPosition[];
  /** New latest position per vessel (`vessel_latest` upsert). */
  readonly latest: readonly RecordedPosition[];
  /** `ais.position.recorded.v1` payload sources, per vessel in time order. */
  readonly events: readonly PositionRecord[];
  /** One per input row, in input order. */
  readonly results: readonly RowResolution[];
}

/**
 * The coast distance as the prediction reads it: `null` encodes the
 * `Infinity` of a coastline without polygons (the only non-finite distance
 * the coastline service returns).
 */
function predictionDistanceM(position: RecordedPosition): number {
  return position.coastDistanceM ?? Infinity;
}

/** `position` with its predicted navstatus computed against `previous` (legacy: itself when `null`). */
function predicted(
  position: RecordedPosition,
  previous: RecordedPosition | null,
): RecordedPosition {
  return {
    ...position,
    predictedNavstatus: predictNavStatus(
      position,
      previous,
      predictionDistanceM(position),
    ),
  };
}

function sameTime(
  a: RecordedPosition | null,
  b: RecordedPosition | null,
): boolean {
  return (a?.time.getTime() ?? null) === (b?.time.getTime() ?? null);
}

/**
 * Resolves a write batch against the latest positions stored in the
 * database (read under lock in the same transaction), which are
 * authoritative over the processor's in-memory and Valkey state:
 *
 * - a candidate newer than the vessel's stored (or previously resolved)
 *   latest position is recorded: it becomes the latest position, links
 *   back to that position as `previous`, and its predicted navstatus is
 *   computed against it (legacy `calculatePredictedNavStatus`, previous =
 *   the latest position);
 * - a candidate that is not newer — the state the decision used was stale,
 *   e.g. another replica recorded the vessel meanwhile — is demoted to an
 *   out-of-order row: stored for the track, never the latest state, no
 *   event, so `previous` links never point backwards or skip a position;
 * - out-of-order rows pass through unchanged.
 *
 * Candidates of one vessel are resolved in time order.
 *
 * @method data.ais_ingest_rules (latest-position and out-of-order rules, spec §13.2, §15.1)
 * @method navstatus.prediction (previous = the latest recorded position)
 * @param rows - the batch, in decision order
 * @param stored - stored latest position of the batch's candidate vessels
 * @see ../../../../../docs/METHODOLOGY.md#data.ais_ingest_rules
 * @see ../../../../../docs/METHODOLOGY.md#navstatus.prediction
 * @see be-legacy/src/services/ais.service.ts (createOrUpdateAis)
 */
export function resolveBatch(
  rows: readonly PositionRow[],
  stored: ReadonlyMap<number, RecordedPosition>,
): BatchResolution {
  const resolvedRows = rows.map((row) => row.position);
  const outcomes: { outcome: RowOutcome; stale: boolean }[] = rows.map(() => ({
    outcome: 'stored',
    stale: false,
  }));
  const latestAfter: (RecordedPosition | null)[] = rows.map(() => null);
  const candidates = new Map<number, number[]>();
  rows.forEach((row, index) => {
    if (!row.latest) return;
    const indices = candidates.get(row.position.mmsi) ?? [];
    indices.push(index);
    candidates.set(row.position.mmsi, indices);
  });

  const latest: RecordedPosition[] = [];
  const events: PositionRecord[] = [];
  for (const [mmsi, indices] of candidates) {
    const ordered = indices
      .map((index) => ({ index, row: rows[index] }))
      .flatMap(({ index, row }) => (row === undefined ? [] : [{ index, row }]))
      .sort(
        (a, b) => a.row.position.time.getTime() - b.row.position.time.getTime(),
      );
    const before = stored.get(mmsi) ?? null;
    let current = before;
    for (const { index, row } of ordered) {
      const candidate = row.position;
      if (
        current !== null &&
        candidate.time.getTime() <= current.time.getTime()
      ) {
        resolvedRows[index] = predicted(candidate, null);
        outcomes[index] = { outcome: 'demoted', stale: true };
        continue;
      }
      const position = predicted(candidate, current);
      resolvedRows[index] = position;
      outcomes[index] = {
        outcome: 'recorded',
        stale: !sameTime(row.assumedPrevious, current),
      };
      events.push({ position, previous: current });
      current = position;
    }
    if (current !== null && current !== before) latest.push(current);
    for (const { index } of ordered) latestAfter[index] = current;
  }

  return {
    rows: resolvedRows,
    latest,
    events,
    results: outcomes.map((outcome, index) => ({
      ...outcome,
      latest: latestAfter[index] ?? null,
    })),
  };
}
