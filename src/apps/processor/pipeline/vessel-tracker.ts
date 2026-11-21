import { LRUCache } from 'lru-cache';

import type { RecordedPosition } from './recorded-position.js';

/** Raised for work queued behind a failed load or commit of the same vessel. */
export class VesselStateResetError extends Error {
  override readonly name = 'VesselStateResetError';

  constructor(mmsi: number) {
    super(
      `The state of vessel ${mmsi} was reset after a failure; the report is retried`,
    );
  }
}

/** In-flight state of one vessel. */
export interface VesselEntry {
  readonly mmsi: number;
  /** Latest position: committed, or decided and still being committed. */
  state: RecordedPosition | null;
  /** Commit of {@link state} while it is pending, else `null`. */
  latestCommit: Promise<void> | null;
  /** @internal FIFO of decisions; starts with the state load. */
  queue: Promise<void>;
  /** @internal Tail of the commit chain (publish order). */
  commits: Promise<void>;
  /** @internal Handlers holding the entry. */
  users: number;
  /** @internal A load or commit failed: the entry is detached. */
  failed: boolean;
}

/** Loads the last committed position of a vessel (Valkey, then the database). */
export type StateLoader = (mmsi: number) => Promise<RecordedPosition | null>;

/**
 * Per-vessel state of the processor: the last position in an in-memory LRU
 * (`AIS_STATE_CACHE_SIZE`) in front of the shared store, and the ordering
 * rules that keep concurrent handling of one vessel's reports consistent:
 *
 * - decisions run one at a time per vessel, in arrival order, after the
 *   vessel's state was loaded ({@link decide});
 * - commits (publish + store) run in decision order ({@link chainCommit});
 *   when one fails, every later commit of the vessel fails too and the entry
 *   is discarded, so retried reports start again from the last committed
 *   state instead of chaining onto a position that was never published;
 * - entries with work in flight are pinned (never evicted).
 */
export class VesselTracker {
  private readonly active = new Map<number, VesselEntry>();
  private readonly idle: LRUCache<number, RecordedPosition>;

  constructor(
    private readonly load: StateLoader,
    maxCachedVessels: number,
  ) {
    this.idle = new LRUCache({ max: maxCachedVessels });
  }

  /** Vessels in memory (with work in flight or cached). */
  get size(): number {
    return this.active.size + this.idle.size;
  }

  /** Takes a vessel's entry for one report; pair with {@link release}. */
  acquire(mmsi: number): VesselEntry {
    let entry = this.active.get(mmsi);
    if (entry === undefined) {
      const cached = this.idle.get(mmsi);
      const created: VesselEntry = {
        mmsi,
        state: cached ?? null,
        latestCommit: null,
        queue: Promise.resolve(),
        commits: Promise.resolve(),
        users: 0,
        failed: false,
      };
      if (cached === undefined) {
        created.queue = this.load(mmsi).then(
          (state) => {
            created.state = state;
          },
          (error: unknown) => {
            this.fail(created);
            throw error;
          },
        );
      }
      this.idle.delete(mmsi);
      this.active.set(mmsi, created);
      entry = created;
    }
    entry.users += 1;
    return entry;
  }

  /** Returns the entry; the last user caches its state. */
  release(entry: VesselEntry): void {
    entry.users -= 1;
    if (
      entry.users > 0 ||
      entry.failed ||
      this.active.get(entry.mmsi) !== entry
    )
      return;
    this.active.delete(entry.mmsi);
    if (entry.state !== null) this.idle.set(entry.mmsi, entry.state);
  }

  /**
   * Runs `decision` (synchronous) after every earlier decision of the vessel
   * and after its state is loaded.
   *
   * @throws {VesselStateResetError} when the entry failed meanwhile
   */
  decide<T>(
    entry: VesselEntry,
    decision: (entry: VesselEntry) => T,
  ): Promise<T> {
    const run = entry.queue.then(() => {
      if (entry.failed) throw new VesselStateResetError(entry.mmsi);
      return decision(entry);
    });
    entry.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Chains the commit of a decided position: waits for `written` (its rows)
   * and for the vessel's previous commit, then runs `commit` (publish +
   * store). Call it from the decision, synchronously, so commits keep the
   * decision order. A failure discards the entry.
   */
  chainCommit(
    entry: VesselEntry,
    written: Promise<void>,
    commit: () => Promise<void>,
  ): Promise<void> {
    const previous = entry.commits;
    const chained = (async () => {
      await written;
      await previous;
      if (entry.failed) throw new VesselStateResetError(entry.mmsi);
      await commit();
    })();
    chained.catch(() => {
      this.fail(entry);
    });
    entry.commits = chained;
    return chained;
  }

  /** Detaches a failed entry: queued work fails, the next report reloads the state. */
  private fail(entry: VesselEntry): void {
    entry.failed = true;
    if (this.active.get(entry.mmsi) === entry) this.active.delete(entry.mmsi);
    this.idle.delete(entry.mmsi);
  }
}
