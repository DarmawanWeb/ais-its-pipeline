import { describe, expect, it, vi } from 'vitest';

import type { TrackPoint, VesselLatest } from './positions.model.js';
import type { PositionsRepository } from './positions.repository.js';
import { PositionsService, TRACK_MAX_POINTS } from './positions.service.js';

const T0 = Date.UTC(2026, 10, 22, 0, 0, 0);

function point(i: number): TrackPoint {
  return {
    time: new Date(T0 + i * 1000),
    lat: -7.2 + i * 1e-6,
    lon: 112.7,
    sog: 5,
    cog: 0,
    hdg: 0,
    navstatus: 0,
    predictedNavstatus: 0,
    source: 'primary',
  };
}

function vessel(mmsi: number): VesselLatest {
  return {
    ...point(0),
    mmsi,
    vessel: null,
  };
}

/**
 * A repository returning the newest `limit` of `count` points in time order
 * (the contract of `rawTrack` / `minuteTrack`) and `count` latest rows.
 */
function repository(count: number) {
  const newest = (range: { limit: number }) =>
    Promise.resolve(
      Array.from({ length: Math.min(count, range.limit) }, (_, i) =>
        point(count - Math.min(count, range.limit) + i),
      ),
    );
  return {
    rawTrack: vi.fn(newest),
    minuteTrack: vi.fn(newest),
    latest: vi.fn((filter: { limit: number }) =>
      Promise.resolve(
        Array.from({ length: Math.min(count, filter.limit) }, (_, i) =>
          vessel(525_000_000 + i),
        ),
      ),
    ),
  };
}

function service(count: number) {
  const repo = repository(count);
  return {
    repo,
    positions: new PositionsService(repo as unknown as PositionsRepository),
  };
}

const request = {
  mmsi: 525005223,
  from: new Date(T0),
  to: new Date(T0 + 7 * 86_400_000),
  resolution: 'raw' as const,
};

describe('PositionsService.track', () => {
  it('returns a complete track as is (no remainingTo)', async () => {
    const { positions } = service(10);
    const track = await positions.track(request);
    expect(track.truncated).toBe(false);
    expect(track.remainingTo).toBeNull();
    expect(track.points).toHaveLength(10);
  });

  it('keeps the NEWEST points of a truncated track and points to the older rest (remainingTo)', async () => {
    const { positions, repo } = service(TRACK_MAX_POINTS + 50);
    const track = await positions.track(request);

    expect(repo.rawTrack).toHaveBeenCalledWith(
      expect.objectContaining({ limit: TRACK_MAX_POINTS + 1 }),
    );
    expect(track.truncated).toBe(true);
    expect(track.points).toHaveLength(TRACK_MAX_POINTS);
    // The track still ends with the newest position of the range.
    expect(track.points.at(-1)?.time).toEqual(
      point(TRACK_MAX_POINTS + 49).time,
    );
    const first = point(50).time;
    expect(track.points[0]?.time).toEqual(first);
    expect(track.remainingTo).toEqual(new Date(first.getTime() - 1));
  });

  it('applies the same rule to one-minute tracks', async () => {
    const { positions, repo } = service(TRACK_MAX_POINTS + 1);
    const track = await positions.track({ ...request, resolution: '1m' });
    expect(repo.minuteTrack).toHaveBeenCalledOnce();
    expect(track.truncated).toBe(true);
    expect(track.points[0]?.time).toEqual(point(1).time);
  });
});

describe('PositionsService.latest', () => {
  const query = { bbox: undefined, since: undefined };

  it('reads one row more than the limit to signal truncation', async () => {
    const { positions, repo } = service(3);
    const result = await positions.latest({ ...query, limit: 2 });
    expect(repo.latest).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3 }),
    );
    expect(result.truncated).toBe(true);
    expect(result.vessels.map((v) => v.mmsi)).toEqual([
      525_000_000, 525_000_001,
    ]);
  });

  it('is complete when no more vessels than the limit match', async () => {
    const { positions } = service(2);
    const result = await positions.latest({ ...query, limit: 2 });
    expect(result.truncated).toBe(false);
    expect(result.vessels).toHaveLength(2);
  });

  it('defaults since to the last 24 h', async () => {
    const { positions, repo } = service(0);
    const now = new Date(T0);
    await positions.latest({ ...query, limit: 1 }, now);
    expect(repo.latest).toHaveBeenCalledWith(
      expect.objectContaining({ since: new Date(T0 - 86_400_000) }),
    );
  });

  it('looks up listed vessels whatever the age of their latest position (no default since), an explicit since still filters', async () => {
    const { positions, repo } = service(0);
    const mmsis = [525005223, 525005224];
    await positions.latest({ ...query, mmsis, limit: 100 }, new Date(T0));
    expect(repo.latest).toHaveBeenLastCalledWith(
      expect.objectContaining({ mmsis, since: undefined, limit: 101 }),
    );
    const since = new Date(T0 - 3_600_000);
    await positions.latest({ ...query, since, mmsis, limit: 100 });
    expect(repo.latest).toHaveBeenLastCalledWith(
      expect.objectContaining({ mmsis, since }),
    );
  });
});

describe('PositionsService.pairTrack', () => {
  it('reads both tracks with the same range, resolution and simplification', async () => {
    const { positions, repo } = service(5);
    const tracks = await positions.pairTrack(525005223, 525005224, {
      from: request.from,
      to: request.to,
      resolution: '1m',
      simplifyM: 25,
    });
    expect(repo.minuteTrack).toHaveBeenCalledTimes(2);
    expect(repo.rawTrack).not.toHaveBeenCalled();
    expect(
      tracks.map((track) => [track.mmsi, track.resolution, track.simplifyM]),
    ).toEqual([
      [525005223, '1m', 25],
      [525005224, '1m', 25],
    ]);
  });

  it('stays raw and unsimplified by default (legacy /ais/routes)', async () => {
    const { positions, repo } = service(5);
    const tracks = await positions.pairTrack(525005223, 525005224, {
      from: request.from,
      to: request.to,
      resolution: 'raw',
    });
    expect(repo.rawTrack).toHaveBeenCalledTimes(2);
    expect(tracks.map((track) => track.simplifyM)).toEqual([null, null]);
  });
});
