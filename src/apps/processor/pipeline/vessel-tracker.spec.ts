import { describe, expect, it, vi } from 'vitest';

import type { RecordedPosition } from './recorded-position.js';
import { VesselStateResetError, VesselTracker } from './vessel-tracker.js';

function position(mmsi: number, second: number): RecordedPosition {
  return {
    mmsi,
    time: new Date(Date.UTC(2026, 10, 21, 10, 0, second)),
    source: 'primary',
    lat: -7.2,
    lon: 112.7 + second / 1000,
    sog: 8,
    cog: 90,
    hdg: 90,
    navstatus: 0,
    predictedNavstatus: 0,
    coastDistanceM: 1000,
  };
}

/** A promise with its settle functions. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('VesselTracker', () => {
  it('loads a vessel once and serves later reports from memory', async () => {
    const load = vi.fn(() => Promise.resolve(position(525005223, 0)));
    const tracker = new VesselTracker(load, 100);

    for (let i = 0; i < 3; i += 1) {
      const entry = tracker.acquire(525005223);
      const state = await tracker.decide(entry, (e) => e.state);
      expect(state?.time).toEqual(position(525005223, 0).time);
      tracker.release(entry);
    }

    expect(load).toHaveBeenCalledTimes(1);
    expect(tracker.size).toBe(1);
  });

  it('runs the decisions of one vessel in arrival order, after the state loaded', async () => {
    const loading = deferred<RecordedPosition | null>();
    const tracker = new VesselTracker(() => loading.promise, 100);
    const order: string[] = [];

    const decisions = ['first', 'second', 'third'].map((name) => {
      const entry = tracker.acquire(525005223);
      return tracker
        .decide(entry, (e) => {
          order.push(`${name}:${String(e.state?.time.getUTCSeconds())}`);
        })
        .finally(() => {
          tracker.release(entry);
        });
    });
    expect(order).toEqual([]);
    loading.resolve(position(525005223, 7));
    await Promise.all(decisions);

    expect(order).toEqual(['first:7', 'second:7', 'third:7']);
  });

  it('chains commits in decision order and fails the later ones of a vessel after a failure', async () => {
    const load = vi.fn(() => Promise.resolve(null));
    const tracker = new VesselTracker(load, 100);
    const entry = tracker.acquire(525005223);
    await tracker.decide(entry, () => undefined);
    const firstWrite = deferred<undefined>();
    const committed: string[] = [];

    const first = tracker.chainCommit(entry, firstWrite.promise, () => {
      committed.push('first');
      return Promise.reject(new Error('publish failed'));
    });
    const second = tracker.chainCommit(
      entry,
      Promise.resolve(undefined),
      () => {
        committed.push('second');
        return Promise.resolve();
      },
    );
    firstWrite.resolve(undefined);

    await expect(first).rejects.toThrow('publish failed');
    // The later commit never runs: it fails with the earlier failure.
    await expect(second).rejects.toThrow('publish failed');
    expect(committed).toEqual(['first']);
    // The detached entry refuses new decisions; the next report reloads the state.
    await expect(tracker.decide(entry, () => 'late')).rejects.toBeInstanceOf(
      VesselStateResetError,
    );
    tracker.release(entry);
    const next = tracker.acquire(525005223);
    await tracker.decide(next, () => undefined);
    tracker.release(next);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('rejects the decisions queued behind a failed load and reloads for the next report', async () => {
    const load = vi
      .fn<(mmsi: number) => Promise<RecordedPosition | null>>()
      .mockRejectedValueOnce(new Error('valkey down'))
      .mockResolvedValueOnce(position(525005223, 3));
    const tracker = new VesselTracker(load, 100);

    const entry = tracker.acquire(525005223);
    const first = tracker.decide(entry, () => 'never');
    const queued = tracker.decide(entry, () => 'never');
    await expect(first).rejects.toThrow('valkey down');
    await expect(queued).rejects.toBeInstanceOf(VesselStateResetError);
    tracker.release(entry);

    const retry = tracker.acquire(525005223);
    const state = await tracker.decide(retry, (e) => e.state);
    tracker.release(retry);
    expect(state?.time.getUTCSeconds()).toBe(3);
  });

  it('keeps at most the configured number of idle vessels (LRU) and never evicts busy ones', async () => {
    const load = vi.fn((mmsi: number) => Promise.resolve(position(mmsi, 0)));
    const tracker = new VesselTracker(load, 2);
    const busy = tracker.acquire(525000000);
    await tracker.decide(busy, () => undefined);

    for (const mmsi of [525000001, 525000002, 525000003]) {
      const entry = tracker.acquire(mmsi);
      await tracker.decide(entry, () => undefined);
      tracker.release(entry);
    }
    expect(tracker.size).toBe(3); // the busy one + two idle ones
    const evicted = tracker.acquire(525000001);
    await tracker.decide(evicted, () => undefined);
    tracker.release(evicted);
    tracker.release(busy);

    expect(load.mock.calls.map(([mmsi]) => mmsi)).toEqual([
      525000000, 525000001, 525000002, 525000003, 525000001,
    ]);
  });
});
