import { describe, expect, it } from 'vitest';

import { calculatePredictedNavStatus } from '../../../shared/domain/navstatus.js';
import type { RecordedPosition } from './recorded-position.js';
import { type PositionRow, resolveBatch } from './resolve-batch.js';

const T0 = Date.UTC(2026, 10, 21, 10, 0, 0);

function position(
  mmsi: number,
  second: number,
  overrides: Partial<RecordedPosition> = {},
): RecordedPosition {
  return {
    mmsi,
    time: new Date(T0 + second * 1000),
    source: 'primary',
    lat: -7.2 + second / 10_000,
    lon: 112.7,
    sog: 8,
    cog: 90,
    hdg: 92,
    navstatus: 0,
    predictedNavstatus: 0,
    coastDistanceM: 5000,
    ...overrides,
  };
}

const candidate = (
  p: RecordedPosition,
  assumedPrevious: RecordedPosition | null,
): PositionRow => ({ position: p, latest: true, assumedPrevious });

const outOfOrder = (p: RecordedPosition): PositionRow => ({
  position: p,
  latest: false,
  assumedPrevious: null,
});

const seconds = (p: RecordedPosition | null | undefined) =>
  p === null || p === undefined ? null : (p.time.getTime() - T0) / 1000;

describe('resolveBatch', () => {
  it('records candidates newer than the stored latest position and chains their previous links', () => {
    const stored = position(1, 0);
    const p10 = position(1, 10);
    const p20 = position(1, 20);
    const resolution = resolveBatch(
      [candidate(p10, stored), candidate(p20, p10)],
      new Map([[1, stored]]),
    );

    expect(
      resolution.events.map((e) => [seconds(e.position), seconds(e.previous)]),
    ).toEqual([
      [10, 0],
      [20, 10],
    ]);
    expect(resolution.latest.map(seconds)).toEqual([20]);
    expect(
      resolution.results.map((r) => [r.outcome, r.stale, seconds(r.latest)]),
    ).toEqual([
      ['recorded', false, 20],
      ['recorded', false, 20],
    ]);
  });

  it('records a first position (no stored latest) with previous null', () => {
    const p = position(1, 0);
    const resolution = resolveBatch([candidate(p, null)], new Map());

    expect(resolution.events).toEqual([{ position: p, previous: null }]);
    expect(resolution.latest).toEqual([p]);
    expect(resolution.results).toEqual([
      { outcome: 'recorded', stale: false, latest: p },
    ]);
  });

  it('demotes a candidate that is not newer than the stored latest position (stale decision): no event, no latest change', () => {
    // The decision assumed t=0 was latest; another replica stored t=30.
    const stored = position(1, 30);
    const p20 = position(1, 20);
    const resolution = resolveBatch(
      [candidate(p20, position(1, 0))],
      new Map([[1, stored]]),
    );

    expect(resolution.events).toEqual([]);
    expect(resolution.latest).toEqual([]);
    expect(resolution.rows.map(seconds)).toEqual([20]);
    expect(resolution.results).toEqual([
      { outcome: 'demoted', stale: true, latest: stored },
    ]);
  });

  it('links a newer candidate decided on a stale state to the stored latest position and flags it', () => {
    const stored = position(1, 30);
    const p40 = position(1, 40);
    const resolution = resolveBatch(
      [candidate(p40, position(1, 0))],
      new Map([[1, stored]]),
    );

    expect(
      resolution.events.map((e) => [seconds(e.position), seconds(e.previous)]),
    ).toEqual([[40, 30]]);
    expect(resolution.results[0]).toMatchObject({
      outcome: 'recorded',
      stale: true,
    });
  });

  it('a redelivered candidate equal to the stored latest position is demoted (its event was enqueued with it)', () => {
    const stored = position(1, 30);
    const resolution = resolveBatch(
      [candidate(position(1, 30), position(1, 0))],
      new Map([[1, stored]]),
    );

    expect(resolution.events).toEqual([]);
    expect(resolution.results[0]?.outcome).toBe('demoted');
  });

  it('recomputes the predicted navstatus against the resolved previous position (legacy rule)', () => {
    // Stored: at anchor; the decision assumed an older under-way position.
    const stored = position(1, 30, { sog: 0.1, cog: 10, hdg: 12 });
    const anchored = position(1, 40, {
      sog: 0.1,
      cog: 10,
      hdg: 12,
      predictedNavstatus: 0,
    });
    const resolution = resolveBatch(
      [candidate(anchored, position(1, 0))],
      new Map([[1, stored]]),
    );

    expect(resolution.rows[0]?.predictedNavstatus).toBe(
      calculatePredictedNavStatus(anchored, stored, 5000),
    );
    expect(resolution.rows[0]?.predictedNavstatus).toBe(1);
    expect(resolution.events[0]?.position.predictedNavstatus).toBe(1);
  });

  it('reads a missing coast distance as the Infinity of a coastline without polygons', () => {
    const p = position(1, 0, {
      sog: 0.1,
      cog: 10,
      hdg: 12,
      coastDistanceM: null,
    });
    const resolution = resolveBatch([candidate(p, null)], new Map());

    expect(resolution.rows[0]?.predictedNavstatus).toBe(
      calculatePredictedNavStatus(p, p, Infinity),
    );
  });

  it('passes out-of-order rows through and resolves several vessels independently, in time order', () => {
    const late = position(2, -50);
    const a10 = position(1, 10);
    const b5 = position(2, 5);
    const a5 = position(1, 5);
    const resolution = resolveBatch(
      // a5 after a10 in the batch (never produced by the pipeline): sorted by time.
      [
        outOfOrder(late),
        candidate(a10, a5),
        candidate(b5, null),
        candidate(a5, null),
      ],
      new Map([[2, position(2, 0)]]),
    );

    expect(resolution.results.map((r) => r.outcome)).toEqual([
      'stored',
      'recorded',
      'recorded',
      'recorded',
    ]);
    expect(resolution.results[0]?.latest).toBeNull();
    expect(
      resolution.events.map((e) => [
        e.position.mmsi,
        seconds(e.position),
        seconds(e.previous),
      ]),
    ).toEqual([
      [1, 5, null],
      [1, 10, 5],
      [2, 5, 0],
    ]);
    expect(resolution.latest.map((p) => [p.mmsi, seconds(p)])).toEqual([
      [1, 10],
      [2, 5],
    ]);
    expect(resolution.rows).toHaveLength(4);
  });
});
