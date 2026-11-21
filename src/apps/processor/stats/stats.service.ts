import {
  AIS_SOURCES,
  type AisSource,
} from '@darmawanweb/ais-its-contracts/domain';
import { Injectable } from '@nestjs/common';

import { StatsRepository } from './stats.repository.js';

/** A vessel is active when its latest position is at most this old. */
export const ACTIVE_WINDOW_MS = 10 * 60_000;

/** Counts of one feed (or of all of them). */
export interface FeedStats {
  readonly activeVessels: number;
  readonly messagesLastMinute: number;
}

/** `GET /ais/stats`. */
export interface AisStats extends FeedStats {
  readonly at: Date;
  readonly activeWindowMinutes: number;
  readonly bySource: Readonly<Record<AisSource, FeedStats>>;
}

/** Live counters from the database (consistent across processor replicas). */
@Injectable()
export class StatsService {
  constructor(private readonly repository: StatsRepository) {}

  /**
   * `activeVessels`: vessels with a position in the last 10 minutes;
   * `messagesLastMinute`: positions recorded with a position time in the last minute.
   */
  async stats(now: Date = new Date()): Promise<AisStats> {
    const [active, recorded] = await Promise.all([
      this.repository.activeVessels(new Date(now.getTime() - ACTIVE_WINDOW_MS)),
      this.repository.recordedPositions(new Date(now.getTime() - 60_000)),
    ]);
    const feed = (source: AisSource): FeedStats => ({
      activeVessels: active.get(source) ?? 0,
      messagesLastMinute: recorded.get(source) ?? 0,
    });
    // Every feed, also those without traffic (a new AisSource fails to compile here).
    const bySource: Record<AisSource, FeedStats> = {
      primary: feed('primary'),
      batam: feed('batam'),
      pusher: feed('pusher'),
    };
    const total = (pick: (stats: FeedStats) => number): number =>
      AIS_SOURCES.reduce((sum, source) => sum + pick(bySource[source]), 0);
    return {
      at: now,
      activeWindowMinutes: ACTIVE_WINDOW_MS / 60_000,
      activeVessels: total((stats) => stats.activeVessels),
      messagesLastMinute: total((stats) => stats.messagesLastMinute),
      bySource,
    };
  }
}
