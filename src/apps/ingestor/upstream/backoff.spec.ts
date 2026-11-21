import { describe, expect, it } from 'vitest';

import { reconnectDelayMs } from './backoff.js';

describe('reconnectDelayMs', () => {
  it('doubles from the minimum up to the maximum', () => {
    const middle = () => 0.5; // no jitter
    expect(
      [0, 1, 2, 3, 10].map((n) =>
        reconnectDelayMs(n, 1000, 30_000, 0.5, middle),
      ),
    ).toEqual([1000, 2000, 4000, 8000, 30_000]);
  });

  it('applies ±jitter without exceeding the maximum', () => {
    expect(reconnectDelayMs(0, 1000, 30_000, 0.5, () => 0)).toBe(500);
    expect(reconnectDelayMs(0, 1000, 30_000, 0.5, () => 1)).toBe(1500);
    expect(reconnectDelayMs(20, 1000, 30_000, 0.5, () => 1)).toBe(30_000);
  });
});
