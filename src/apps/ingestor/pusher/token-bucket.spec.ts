import { describe, expect, it } from 'vitest';

import { TokenBucket } from './token-bucket.js';

describe('TokenBucket', () => {
  it('allows a burst up to the capacity, then the sustained rate', () => {
    const bucket = new TokenBucket(10, 100, 0);
    expect(bucket.take(100, 0)).toBe(0);
    expect(bucket.take(1, 0)).toBe(100);
    expect(bucket.take(5, 500)).toBe(0);
    expect(bucket.take(1, 500)).toBe(100);
  });

  it('never exceeds the capacity and refuses costs above it', () => {
    const bucket = new TokenBucket(10, 20, 0);
    expect(bucket.take(20, 60_000)).toBe(0);
    expect(bucket.take(21, 120_000)).toBe(Number.POSITIVE_INFINITY);
  });
});
