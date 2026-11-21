import { describe, expect, it } from 'vitest';

import { RateWindow } from './rate-window.js';

describe('RateWindow', () => {
  it('sums the events of the last 60 seconds', () => {
    const window = new RateWindow();
    const t = 1_700_000_000_000;
    window.add(t, 3);
    window.add(t + 30_000);
    window.add(t + 59_999, 2);

    expect(window.total(t + 59_999)).toBe(6);
    expect(window.total(t + 60_000)).toBe(3);
    expect(window.total(t + 200_000)).toBe(0);
  });

  it('recycles buckets of past seconds', () => {
    const window = new RateWindow(2);
    window.add(0, 5);
    window.add(2000, 1);

    expect(window.total(2000)).toBe(1);
  });
});
