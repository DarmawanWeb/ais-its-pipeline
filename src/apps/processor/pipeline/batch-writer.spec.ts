import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BatchWriter } from './batch-writer.js';

/** A sink whose batches complete when the test says so. */
function controllableSink() {
  const batches: number[][] = [];
  const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const sink = (rows: readonly number[]): Promise<void> => {
    batches.push([...rows]);
    return new Promise<void>((resolve, reject) =>
      pending.push({ resolve, reject }),
    );
  };
  return { sink, batches, pending };
}

const flushImmediates = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

describe('BatchWriter', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the rows of one event-loop turn as one batch when idle', async () => {
    const { sink, batches, pending } = controllableSink();
    const writer = new BatchWriter(sink, { maxRows: 500, maxDelayMs: 1000 });
    const writes = [writer.write(1), writer.write(2), writer.write(3)];
    await flushImmediates();

    expect(batches).toEqual([[1, 2, 3]]);
    pending[0]?.resolve();
    await expect(Promise.all(writes)).resolves.toBeDefined();
  });

  it('groups rows written while a batch is in flight (group commit)', async () => {
    const { sink, batches, pending } = controllableSink();
    const writer = new BatchWriter(sink, {
      maxRows: 500,
      maxDelayMs: 1000,
      maxConcurrent: 1,
    });
    void writer.write(1);
    await flushImmediates();
    const later = [writer.write(2), writer.write(3)];
    await flushImmediates();
    expect(batches).toEqual([[1]]);

    pending[0]?.resolve();
    await flushImmediates();
    expect(batches).toEqual([[1], [2, 3]]);
    pending[1]?.resolve();
    await Promise.all(later);
  });

  it('starts a batch at maxRows and caps its size', async () => {
    const { sink, batches } = controllableSink();
    const writer = new BatchWriter(sink, { maxRows: 2, maxDelayMs: 1000 });
    void writer.write(1);
    void writer.write(2);
    void writer.write(3);

    expect(batches).toEqual([[1, 2]]);
    await flushImmediates();
    expect(batches).toEqual([[1, 2]]);
    vi.advanceTimersByTime(1000);
    expect(batches).toEqual([[1, 2], [3]]);
  });

  it('flushes buffered rows at the latest after maxDelayMs while busy', async () => {
    const { sink, batches } = controllableSink();
    const writer = new BatchWriter(sink, {
      maxRows: 100,
      maxDelayMs: 50,
      maxConcurrent: 2,
    });
    void writer.write(1);
    await flushImmediates();
    void writer.write(2);
    expect(batches).toEqual([[1]]);

    vi.advanceTimersByTime(50);
    expect(batches).toEqual([[1], [2]]);
  });

  it('rejects every row of a failed batch', async () => {
    const { sink, pending } = controllableSink();
    const writer = new BatchWriter(sink, { maxRows: 10, maxDelayMs: 1000 });
    const writes = [writer.write(1), writer.write(2)];
    await flushImmediates();
    pending[0]?.reject(new Error('db down'));

    for (const write of writes) await expect(write).rejects.toThrow('db down');
  });

  it('drains buffered and in-flight batches', async () => {
    const { sink, batches, pending } = controllableSink();
    const writer = new BatchWriter(sink, {
      maxRows: 2,
      maxDelayMs: 10_000,
      maxConcurrent: 1,
    });
    for (const row of [1, 2, 3]) void writer.write(row);
    const drained = writer.drain();
    pending[0]?.resolve();
    await flushImmediates();
    expect(batches).toEqual([[1, 2], [3]]);
    pending[1]?.resolve();
    await drained;
    expect(writer.buffered).toBe(0);
  });
});
