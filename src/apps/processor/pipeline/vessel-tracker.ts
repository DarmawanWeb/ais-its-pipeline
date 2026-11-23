import { LRUCache } from 'lru-cache';

import type { RecordedPosition } from './recorded-position.js';

/** Raised for decisions queued behind a failed load or write of the same vessel. */
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
  /** Latest position: committed, or decided and still being written. */
  state: RecordedPosition | null;
  /** Write of {@link state} while it is pending, else `null`. */
  latestCommit: Promise<void> | null;
  /** @internal FIFO of decisions; starts with the state load. */
  queue: Promise<void>;
  /** @internal Settles when every write tracked so far settled (never rejects). */
  commits: Promise<void>;
  /** @internal Handlers holding the entry. */
  users: number;
  /** @internal A load or write failed: queued decisions are retried. */
  failed: boolean;
}

/** Where the tracker gets the last committed position of a vessel. */
export interface VesselStateSource {
  /** The last committed position (Valkey, then the database), `null` for a vessel never seen. */
  load(mmsi: number): Promise<RecordedPosition | null>;
  /** Whether a position cached in memory is still the vessel's last one (no newer one was stored). */
  isCurrent(cached: RecordedPosition): Promise<boolean>;
}

const settle = (promise: Promise<unknown>): Promise<void> =>
  promise.then(
    () => undefined,
    () => undefined,
  );

/**
 * Per-vessel state of the processor: the last position in an in-memory LRU
 * (`AIS_STATE_CACHE_SIZE`) in front of the shared store, and the ordering
 * rules that keep concurrent handling of one vessel's reports consistent:
 *
 * - decisions run one at a time per vessel, in arrival order, after the
 *   vessel's state was loaded ({@link decide});
 * - every state is dropped when this instance becomes the active processor
 *   ({@link reset}): another replica may have recorded the vessels while
 *   it stood by (failover, failback);
 * - a cached state is also revalidated against the store before it is used
 *   ({@link VesselStateSource.isCurrent}), a defence for writes outside a
 *   pin change (the previous instance's batches still committing right
 *   after a takeover);
 * - an entry is detached when one of its writes failed ({@link fail}) or
 *   turned out to be based on a stale state ({@link invalidate}); the next
 *   report of the vessel waits until the detached entry's decisions and
 *   writes settled, then reloads the state;
 * - entries with work in flight are pinned (never evicted).
 */
export class VesselTracker {
  private readonly active = new Map<number, VesselEntry>();
  private readonly idle: LRUCache<number, RecordedPosition>;
  /** Detached entries whose work is still settling, per vessel. */
  private readonly detached = new Map<number, Promise<void>>();

  constructor(
    private readonly source: VesselStateSource,
    maxCachedVessels: number,
  ) {
    this.idle = new LRUCache({ max: maxCachedVessels });
  }

  /** Vessels in memory (with work in flight or cached). */
  get size(): number {
    return this.active.size + this.idle.size;
  }

  /**
   * Takes a vessel's entry for one report; pair with {@link release}, and
   * call {@link decide} right away (synchronously) for the report.
   */
  acquire(mmsi: number): VesselEntry {
    let entry = this.active.get(mmsi);
    if (entry === undefined) {
      const cached = this.idle.get(mmsi);
      this.idle.delete(mmsi);
      const settling = this.detached.get(mmsi);
      const created: VesselEntry = {
        mmsi,
        state: null,
        latestCommit: null,
        queue: Promise.resolve(),
        commits: Promise.resolve(),
        users: 0,
        failed: false,
      };
      created.queue = (async () => {
        if (settling !== undefined) await settling;
        created.state =
          cached !== undefined && (await this.source.isCurrent(cached))
            ? cached
            : await this.source.load(mmsi);
      })().catch((error: unknown) => {
        this.fail(created);
        throw error;
      });
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
    entry.queue = settle(run);
    return run;
  }

  /** Tracks a pending write of the entry (detached entries are reloaded only after it settled). */
  track(entry: VesselEntry, write: Promise<unknown>): void {
    entry.commits = Promise.all([entry.commits, settle(write)]).then(
      () => undefined,
    );
  }

  /**
   * Drops every state in memory: cached ones at once, entries with work in
   * flight are detached (their decisions and writes still run; the next
   * report of the vessel waits for them, then reloads the state).
   *
   * @returns the number of vessel states dropped
   */
  reset(): number {
    const dropped = this.size;
    for (const entry of [...this.active.values()]) this.detach(entry);
    this.idle.clear();
    return dropped;
  }

  /** Detaches an entry after a failed write: queued decisions are retried, the next report reloads the state. */
  fail(entry: VesselEntry): void {
    entry.failed = true;
    this.detach(entry);
  }

  /**
   * Detaches an entry whose state turned out to be stale: queued decisions
   * still run (their writes are resolved against the stored state), the
   * next report reloads the state once they settled.
   */
  invalidate(entry: VesselEntry): void {
    this.detach(entry);
  }

  private detach(entry: VesselEntry): void {
    const { mmsi } = entry;
    this.idle.delete(mmsi);
    if (this.active.get(mmsi) !== entry) return;
    this.active.delete(mmsi);
    // Every decision of the entry is queued already (decide() follows
    // acquire() synchronously); wait for them, then for their writes.
    const settling = settle(entry.queue).then(() => entry.commits);
    this.detached.set(mmsi, settling);
    void settling.then(() => {
      if (this.detached.get(mmsi) === settling) this.detached.delete(mmsi);
    });
  }
}
