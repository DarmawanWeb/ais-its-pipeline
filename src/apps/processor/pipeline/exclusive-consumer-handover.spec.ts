import { describe, expect, it } from 'vitest';

import {
  handoverBudgetMs,
  SHUTDOWN_HEADROOM_MS,
} from './exclusive-consumer-handover.js';

describe('handoverBudgetMs', () => {
  it('leaves headroom before the kit exits the process at SHUTDOWN_TIMEOUT_MS', () => {
    expect(handoverBudgetMs(30_000)).toBe(30_000 - SHUTDOWN_HEADROOM_MS);
    expect(handoverBudgetMs(60_000)).toBe(55_000);
  });

  it('waits at least 1 s, and 25 s without a shutdown deadline (0)', () => {
    expect(handoverBudgetMs(3000)).toBe(1000);
    expect(handoverBudgetMs(0)).toBe(25_000);
  });
});
