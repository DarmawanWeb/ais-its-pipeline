import { readFileSync } from 'node:fs';

import * as z from 'zod';

const Motion = z.object({ sog: z.number(), cog: z.number(), hdg: z.number() });
const Fix = z.object({ lat: z.number(), lon: z.number() });

const LegacyGoldensSchema = z.object({
  generatedBy: z.string(),
  coast: z.array(
    z.object({
      name: z.string(),
      lat: z.number(),
      lon: z.number(),
      meters: z.number(),
    }),
  ),
  predictions: z.array(
    z.object({
      current: Motion,
      previous: Motion.nullable(),
      /** JSON has no Infinity: the string marks it. */
      coastDistanceM: z.union([
        z.number(),
        z.literal('Infinity').transform(() => Number.POSITIVE_INFINITY),
      ]),
      predicted: z.union([z.literal(0), z.literal(1)]),
    }),
  ),
  haversine: z.array(
    z.object({ from: Fix, to: Fix, nm: z.number(), meters: z.number() }),
  ),
});

/**
 * Values produced once by the original legacy functions
 * (`scripts/legacy-goldens.mjs`): `findNearestCoastDistance` (turf 7.2.0),
 * `calculatePredictedNavStatus` and `calculateDistance`.
 */
export const LEGACY_GOLDENS = LegacyGoldensSchema.parse(
  JSON.parse(
    readFileSync(new URL('legacy-goldens.json', import.meta.url), 'utf8'),
  ),
);
