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

/** A state source: `load` from the store, `isCurrent` = the cache is still valid. */
function source(
  load: (mmsi: number) => Promise<RecordedPosition | null>,
  isCurrent: (cached: RecordedPosition) => Promise<boolean> = () =>
    Promise.resolve(true),
) {
  return { load: vi.fn(load), isCurrent: vi.fn(isCurrent) };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('VesselTracker', () => {
  it('loads a vessel once and serves later reports from memory, revalidated before each use', async () => {
    const state = source(() => Promise.resolve(position(525005223, 0)));
    const tracker = new VesselTracker(state, 100);

    for (let i = 0; i < 3; i += 1) {
      const entry = tracker.acquire(525005223);
      const current = await tracker.decide(entry, (e) => e.state);
      expect(current?.time).toEqual(position(525005223, 0).time);
      tracker.release(entry);
    }

    expect(state.load).toHaveBeenCalledTimes(1);
    expect(state.isCurrent).toHaveBeenCalledTimes(2);
    expect(tracker.size).toBe(1);
  });

  it('reloads a cached state that another replica superseded (stale after a failover)', async () => {
    const state = source(
      vi
        .fn<(mmsi: number) => Promise<RecordedPosition | null>>()
        .mockResolvedValueOnce(position(525005223, 0))
        .mockResolvedValueOnce(position(525005223, 30)),
      () => Promise.resolve(false),
    );
    const tracker = new VesselTracker(state, 100);
    const first = tracker.acquire(525005223);
    await tracker.decide(first, () => undefined);
    tracker.release(first);

    const next = tracker.acquire(525005223);
    const current = await tracker.decide(next, (e) => e.state);
    tracker.release(next);

    expect(current?.time.getUTCSeconds()).toBe(30);
    expect(state.isCurrent).toHaveBeenCalledWith(position(525005223, 0));
    expect(state.load).toHaveBeenCalledTimes(2);
  });

  it('runs the decisions of one vessel in arrival order, after the state loaded', async () => {
    const loading = deferred<RecordedPosition | null>();
    const tracker = new VesselTracker(
      source(() => loading.promise),
      100,
    );
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

  it('after a failed write, retries the queued decisions and reloads only once the detached writes settled', async () => {
    const state = source(() => Promise.resolve(position(525005223, 0)));
    const tracker = new VesselTracker(state, 100);
    const entry = tracker.acquire(525005223);
    await tracker.decide(entry, () => undefined);
    // An earlier write of the vessel is still in flight when a later one fails.
    const earlier = deferred<undefined>();
    tracker.track(entry, earlier.promise);
    tracker.track(entry, Promise.reject(new Error('db down')));
    tracker.fail(entry);

    await expect(tracker.decide(entry, () => 'late')).rejects.toBeInstanceOf(
      VesselStateResetError,
    );
    tracker.release(entry);
    const next = tracker.acquire(525005223);
    const decided = tracker.decide(next, (e) => e.state);
    await tick();
    // The new entry waits for the detached entry's pending write.
    expect(state.load).toHaveBeenCalledTimes(1);
    earlier.resolve(undefined);
    await expect(decided).resolves.toEqual(position(525005223, 0));
    tracker.release(next);
    expect(state.load).toHaveBeenCalledTimes(2);
  });

  it('lets the decisions queued on an invalidated entry run and reloads for the next report', async () => {
    const state = source(() => Promise.resolve(position(525005223, 0)));
    const tracker = new VesselTracker(state, 100);
    const entry = tracker.acquire(525005223);
    const queued = tracker.decide(entry, () => 'queued');
    tracker.invalidate(entry);

    await expect(queued).resolves.toBe('queued');
    tracker.release(entry);
    expect(tracker.size).toBe(0); // an invalidated state is not cached
    const next = tracker.acquire(525005223);
    await tracker.decide(next, () => undefined);
    tracker.release(next);
    expect(state.load).toHaveBeenCalledTimes(2);
    expect(state.isCurrent).not.toHaveBeenCalled();
  });

  it('rejects the decisions queued behind a failed load and reloads for the next report', async () => {
    const state = source(
      vi
        .fn<(mmsi: number) => Promise<RecordedPosition | null>>()
        .mockRejectedValueOnce(new Error('database down'))
        .mockResolvedValueOnce(position(525005223, 3)),
    );
    const tracker = new VesselTracker(state, 100);

    const entry = tracker.acquire(525005223);
    const first = tracker.decide(entry, () => 'never');
    const queued = tracker.decide(entry, () => 'never');
    await expect(first).rejects.toThrow('database down');
    await expect(queued).rejects.toBeInstanceOf(VesselStateResetError);
    tracker.release(entry);

    const retry = tracker.acquire(525005223);
    const current = await tracker.decide(retry, (e) => e.state);
    tracker.release(retry);
    expect(current?.time.getUTCSeconds()).toBe(3);
  });

  it('keeps at most the configured number of idle vessels (LRU) and never evicts busy ones', async () => {
    const state = source((mmsi: number) => Promise.resolve(position(mmsi, 0)));
    const tracker = new VesselTracker(state, 2);
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

    expect(state.load.mock.calls.map(([mmsi]) => mmsi)).toEqual([
      525000000, 525000001, 525000002, 525000003, 525000001,
    ]);
  });
});
