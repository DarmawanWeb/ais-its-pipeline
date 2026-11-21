/**
 * Delay before reconnection attempt `attempt` (0-based): `minMs · 2^attempt`
 * capped at `maxMs`, spread by ±`jitter` (fraction) so that many clients do
 * not reconnect in lockstep.
 */
export function reconnectDelayMs(
  attempt: number,
  minMs: number,
  maxMs: number,
  jitter = 0.5,
  random: () => number = Math.random,
): number {
  const base = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 30));
  const spread = base * jitter * (random() * 2 - 1);
  return Math.max(0, Math.round(Math.min(maxMs, base + spread)));
}
