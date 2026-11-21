/**
 * Token bucket: `capacity` tokens, refilled continuously at `ratePerSecond`.
 * A pusher connection spends one token per message.
 */
export class TokenBucket {
  private tokens: number;
  private updatedAtMs: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly capacity: number,
    nowMs: number = Date.now(),
  ) {
    this.tokens = capacity;
    this.updatedAtMs = nowMs;
  }

  /**
   * Spends `cost` tokens when available.
   *
   * @returns `0` when allowed, else the wait in ms until `cost` tokens are available
   *   (`Infinity` when `cost` exceeds the capacity)
   */
  take(cost: number, nowMs: number = Date.now()): number {
    this.refill(nowMs);
    if (cost <= this.tokens) {
      this.tokens -= cost;
      return 0;
    }
    if (cost > this.capacity) return Number.POSITIVE_INFINITY;
    return Math.ceil(((cost - this.tokens) / this.ratePerSecond) * 1000);
  }

  private refill(nowMs: number): void {
    const elapsed = Math.max(0, nowMs - this.updatedAtMs);
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (elapsed / 1000) * this.ratePerSecond,
    );
    this.updatedAtMs = nowMs;
  }
}
