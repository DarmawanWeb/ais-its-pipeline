/** Writes one batch atomically (rejects when nothing was written). */
export type BatchSink<Row> = (rows: readonly Row[]) => Promise<void>;

/** Batching policy of a {@link BatchWriter}. */
export interface BatchWriterOptions {
  /** Most rows per batch (`PROCESSOR_BATCH_SIZE`). */
  readonly maxRows: number;
  /** Longest a buffered row waits before a batch is started for it (`PROCESSOR_FLUSH_MS`). */
  readonly maxDelayMs: number;
  /** Batches written at the same time (bounded by the database pool). */
  readonly maxConcurrent?: number | undefined;
}

interface Pending<Row> {
  readonly row: Row;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Group commit for row writes: `write()` resolves once the batch holding
 * the row is committed (callers acknowledge their messages only then). A
 * batch starts as soon as the writer is idle — rows written in the same
 * event-loop turn share it — immediately when `maxRows` rows are waiting,
 * and at the latest `maxDelayMs` after a row was buffered. While batches
 * are in flight new rows accumulate, so batches grow with the load (up to
 * `maxRows`) and the latency stays one transaction at low load.
 */
export class BatchWriter<Row> {
  private buffer: Pending<Row>[] = [];
  private inFlight = 0;
  private timer: NodeJS.Timeout | null = null;
  private immediate: NodeJS.Immediate | null = null;
  private readonly idle = new Set<() => void>();
  private readonly maxConcurrent: number;

  constructor(
    private readonly sink: BatchSink<Row>,
    private readonly options: BatchWriterOptions,
  ) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
  }

  /** Rows waiting for a batch. */
  get buffered(): number {
    return this.buffer.length;
  }

  /** Buffers `row`; resolves when its batch is committed, rejects when the batch failed. */
  write(row: Row): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.buffer.push({ row, resolve, reject });
      if (this.buffer.length >= this.options.maxRows) {
        this.start();
        return;
      }
      this.armTimer();
      if (this.inFlight === 0) this.startSoon();
    });
  }

  /** Writes everything buffered and waits for every batch in flight (shutdown). */
  async drain(): Promise<void> {
    while (this.buffer.length > 0 || this.inFlight > 0) {
      if (this.buffer.length > 0 && this.inFlight < this.maxConcurrent) {
        this.start();
        continue;
      }
      await new Promise<void>((resolve) => this.idle.add(resolve));
    }
  }

  /** Starts a batch after the rows of the current event-loop turn were buffered. */
  private startSoon(): void {
    this.immediate ??= setImmediate(() => {
      this.immediate = null;
      if (this.inFlight === 0) this.start();
    });
  }

  /** Starts one batch of up to `maxRows` buffered rows (when a slot is free). */
  private start(): void {
    if (this.buffer.length === 0 || this.inFlight >= this.maxConcurrent) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.buffer.slice(0, this.options.maxRows);
    this.buffer = this.buffer.slice(batch.length);
    this.inFlight += 1;
    let write: Promise<void>;
    try {
      write = this.sink(batch.map((pending) => pending.row));
    } catch (error) {
      write = Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    write
      .then(
        () => {
          for (const pending of batch) pending.resolve();
        },
        (error: unknown) => {
          for (const pending of batch) pending.reject(error);
        },
      )
      .finally(() => {
        this.inFlight -= 1;
        this.afterBatch();
      });
  }

  /** Group commit: rows buffered meanwhile go out now (full batch or idle writer) or on the timer. */
  private afterBatch(): void {
    if (this.buffer.length >= this.options.maxRows || this.inFlight === 0) {
      this.start();
    } else if (this.buffer.length > 0) {
      this.armTimer();
    }
    for (const resolve of this.idle) resolve();
    this.idle.clear();
  }

  private armTimer(): void {
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.start();
      if (this.buffer.length > 0 && this.inFlight > 0) this.armTimer();
    }, this.options.maxDelayMs);
  }
}
