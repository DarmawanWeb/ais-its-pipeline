import { describe, expect, it } from 'vitest';

import { LEGACY_GOLDENS } from './__fixtures__/legacy-goldens.js';
import { calculatePredictedNavStatus, predictNavStatus } from './navstatus.js';

describe('calculatePredictedNavStatus (golden: legacy calculatePredictedNavStatus)', () => {
  it.each(
    LEGACY_GOLDENS.predictions.map((golden) => [
      JSON.stringify(golden.current),
      JSON.stringify(golden.previous),
      golden.coastDistanceM,
      golden,
    ]),
  )('current %s, previous %s, coast %s m', (_c, _p, _d, golden) => {
    expect(
      calculatePredictedNavStatus(
        golden.current,
        golden.previous,
        golden.coastDistanceM,
      ),
    ).toBe(golden.predicted);
  });

  it('covers both outcomes and the 511 heading branch', () => {
    const outcomes = new Set(
      LEGACY_GOLDENS.predictions.map((g) => g.predicted),
    );
    expect(outcomes).toEqual(new Set([0, 1]));
    expect(
      calculatePredictedNavStatus(
        { sog: 0.1, cog: 200, hdg: 511 },
        { sog: 0.1, cog: 0, hdg: 0 },
        500,
      ),
    ).toBe(1);
  });

  it('predicts 0 for a NaN coast distance and 1 for Infinity (no geometry)', () => {
    const still = { sog: 0, cog: 0, hdg: 0 };
    expect(calculatePredictedNavStatus(still, still, Number.NaN)).toBe(0);
    expect(
      calculatePredictedNavStatus(still, still, Number.POSITIVE_INFINITY),
    ).toBe(1);
  });
});

describe('predictNavStatus', () => {
  it('uses the current report as its own previous for a first report (legacy CASE 1)', () => {
    const moving = { sog: 5, cog: 90, hdg: 91 };
    expect(predictNavStatus(moving, null, 1000)).toBe(
      calculatePredictedNavStatus(moving, moving, 1000),
    );
    expect(predictNavStatus({ sog: 0, cog: 0, hdg: 511 }, null, 1000)).toBe(1);
  });

  it('uses the latest recorded position otherwise', () => {
    const anchored = { sog: 0.1, cog: 10, hdg: 12 };
    const moving = { sog: 8, cog: 10, hdg: 12 };
    expect(predictNavStatus(anchored, moving, 1000)).toBe(0);
    expect(predictNavStatus(anchored, anchored, 1000)).toBe(1);
  });
});
