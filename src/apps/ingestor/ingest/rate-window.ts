/**
 * Events per sliding window of whole seconds (default 60 s), in O(window)
 * memory: one bucket per second, recycled when its second has passed.
 */
export class RateWindow {
  private readonly counts: Float64Array;
  private readonly seconds: Float64Array;

  constructor(private readonly windowSeconds = 60) {
    this.counts = new Float64Array(windowSeconds);
    this.seconds = new Float64Array(windowSeconds).fill(-1);
  }

  /** Records `count` events at `nowMs`. */
  add(nowMs: number, count = 1): void {
    const second = Math.floor(nowMs / 1000);
    const slot = second % this.windowSeconds;
    if (this.seconds[slot] !== second) {
      this.seconds[slot] = second;
      this.counts[slot] = 0;
    }
    this.counts[slot] = (this.counts[slot] ?? 0) + count;
  }

  /** Events in the window ending at `nowMs` (the current second included). */
  total(nowMs: number): number {
    const second = Math.floor(nowMs / 1000);
    let sum = 0;
    for (let slot = 0; slot < this.windowSeconds; slot += 1) {
      const at = this.seconds[slot] ?? -1;
      if (at > second - this.windowSeconds && at <= second) {
        sum += this.counts[slot] ?? 0;
      }
    }
    return sum;
  }
}
