import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  resetProcessorSchema,
  startProcessor,
  startTestAuth,
  type TestAuth,
  type TestProcessor,
} from './support/test-apps.js';

const VESSELS = 10_000;
const WARM_UP = 5;
const SAMPLES = 40;
/** Spec §13.2: p95 < 200 ms for 10 000 vessels. */
const P95_BUDGET_MS = 200;

/** Latency percentiles of a series [ms]. */
function percentiles(samples: readonly number[]): {
  p50: number;
  p95: number;
  max: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  return { p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 };
}

describe('processor: GET /api/v2/ais/latest with 10 000 vessels', () => {
  let auth: TestAuth;
  let processor: TestProcessor;
  let baseUrl: string;
  let headers: { authorization: string };

  beforeAll(async () => {
    auth = await startTestAuth();
    processor = await startProcessor(auth, await resetProcessorSchema());
    // 10 000 vessels over Indonesian waters, seen within the last hour; half
    // of them known to the fleet service (vessel name and type).
    await processor.pool.query(
      `INSERT INTO vessel_latest (mmsi, time, source, lat, lon, geom, sog, cog, hdg, navstatus, pred_navstatus, coast_dist_m)
       SELECT 300000000 + i, now() - (i % 3600) * interval '1 second', 'primary', p.lat, p.lon,
              ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326)::geography,
              (i % 15)::float8, (i % 360)::float8, ((i + 3) % 360)::float8, i % 9, i % 2, 1000 + i
       FROM generate_series(1, $1::int) AS i,
            LATERAL (SELECT -10 + (i * 7919 % 1500) / 100.0 AS lat, 95 + (i * 104729 % 4600) / 100.0 AS lon) AS p`,
      [VESSELS],
    );
    await processor.pool.query(
      `INSERT INTO vessel_refs (mmsi, vessel_id, name, type_code, updated_at)
       SELECT 300000000 + i, gen_random_uuid(), 'Vessel ' || i, 'bulk_carrier', now()
       FROM generate_series(1, $1::int, 2) AS i`,
      [VESSELS],
    );
    await processor.pool.query('ANALYZE vessel_latest; ANALYZE vessel_refs');
    await processor.app.listen(0, '127.0.0.1');
    baseUrl = (await processor.app.getUrl()).replace('[::1]', '127.0.0.1');
    headers = await auth.bearer({ roles: ['viewer'] });
  });

  afterAll(async () => {
    await processor.app.close();
    await auth.close();
  });

  async function measure(path: string): Promise<{
    p50: number;
    p95: number;
    max: number;
    items: number;
    bytes: number;
  }> {
    let items = 0;
    let bytes = 0;
    const durations: number[] = [];
    for (let i = 0; i < WARM_UP + SAMPLES; i += 1) {
      const started = performance.now();
      const response = await fetch(`${baseUrl}${path}`, { headers });
      const body = await response.text();
      const elapsed = performance.now() - started;
      expect(response.status).toBe(200);
      if (i >= WARM_UP) durations.push(elapsed);
      bytes = body.length;
      items = (JSON.parse(body) as unknown[]).length;
    }
    return { ...percentiles(durations), items, bytes };
  }

  it(`serves every vessel (no bbox) with p95 < ${P95_BUDGET_MS} ms`, async () => {
    const result = await measure('/api/v2/ais/latest');
    process.stdout.write(
      `GET /api/v2/ais/latest (${result.items} vessels, ${(result.bytes / 1e6).toFixed(2)} MB): ` +
        `p50 ${result.p50.toFixed(1)} ms, p95 ${result.p95.toFixed(1)} ms, max ${result.max.toFixed(1)} ms over ${SAMPLES} requests\n`,
    );
    expect(result.items).toBe(VESSELS);
    expect(result.p95).toBeLessThan(P95_BUDGET_MS);
  });

  it(`serves a map viewport (bbox) with p95 < ${P95_BUDGET_MS} ms`, async () => {
    const result = await measure('/api/v2/ais/latest?bbox=105,-8,120,-2');
    process.stdout.write(
      `GET /api/v2/ais/latest?bbox=105,-8,120,-2 (${result.items} vessels): ` +
        `p50 ${result.p50.toFixed(1)} ms, p95 ${result.p95.toFixed(1)} ms, max ${result.max.toFixed(1)} ms over ${SAMPLES} requests\n`,
    );
    expect(result.items).toBeGreaterThan(1000);
    expect(result.items).toBeLessThan(VESSELS);
    expect(result.p95).toBeLessThan(P95_BUDGET_MS);
  });

  it(`serves vessels seen in the last 10 minutes with p95 < ${P95_BUDGET_MS} ms`, async () => {
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    const result = await measure(`/api/v2/ais/latest?since=${since}`);
    process.stdout.write(
      `GET /api/v2/ais/latest?since=-10min (${result.items} vessels): ` +
        `p50 ${result.p50.toFixed(1)} ms, p95 ${result.p95.toFixed(1)} ms, max ${result.max.toFixed(1)} ms over ${SAMPLES} requests\n`,
    );
    expect(result.p95).toBeLessThan(P95_BUDGET_MS);
  });
});
