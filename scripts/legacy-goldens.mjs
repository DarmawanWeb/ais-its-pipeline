// Generates the golden values of the parity tests by running the ORIGINAL
// legacy functions once (spec §11: "golden tests with values computed from
// the legacy code"):
//   - findNearestCoastDistance  be-legacy/src/utils/calculate-ews.ts (turf 7.2.0)
//   - calculatePredictedNavStatus  be-legacy/src/services/predict-navstatus.service.ts
//   - calculateDistance  be-legacy/src/utils/cii/speed-calculation.ts
// The legacy TypeScript is transpiled verbatim (types erased) into
// node_modules/.cache and imported with the turf 7.2.0 dev dependencies
// (the versions of the legacy lockfile).
//
//   node scripts/legacy-goldens.mjs <be-legacy checkout> [out]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

const [legacyRoot, out = 'src/shared/domain/__fixtures__/legacy-goldens.json'] =
  process.argv.slice(2);
if (legacyRoot === undefined) {
  process.stderr.write(
    'usage: node scripts/legacy-goldens.mjs <be-legacy> [out]\n',
  );
  process.exit(2);
}

const cache = resolve('node_modules/.cache/legacy-goldens');
mkdirSync(cache, { recursive: true });
const sources = {
  'calculate-ews': 'src/utils/calculate-ews.ts',
  'predict-navstatus': 'src/services/predict-navstatus.service.ts',
  'speed-calculation': 'src/utils/cii/speed-calculation.ts',
};
const modules = {};
for (const [name, path] of Object.entries(sources)) {
  const { outputText } = ts.transpileModule(
    readFileSync(join(legacyRoot, path), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    },
  );
  const file = join(cache, `${name}.mjs`);
  writeFileSync(file, outputText);
  modules[name] = await import(pathToFileURL(file).href);
}
const { findNearestCoastDistance } = modules['calculate-ews'];
const { calculatePredictedNavStatus } = modules['predict-navstatus'];
const { calculateDistance } = modules['speed-calculation'];
const coastFile = join(legacyRoot, 'data/indonesia.json');

/** mulberry32: reproducible pseudo-random points. */
function prng(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const points = [
  ['surabaya-port', -7.2, 112.73],
  ['madura-strait', -7.15, 112.9],
  ['bali-strait', -8.15, 114.42],
  ['inland-malang', -7.98, 112.63],
  ['south-coast', -8.4, 111.5],
  ['lombok-sample', -8.747773333333333, 116.05734],
  ['java-sea-north', -6.5, 112.5],
  ['batam', 1.1, 104.0],
  ['jakarta', -6.1, 106.85],
  ['makassar', -5.13, 119.41],
  ['vertex-exact', -8.432652375999965, 112.70933354500005],
  ['near-vertex', -8.4326, 112.7093],
  [
    'segment-mid',
    (-8.432652375999965 + -8.431055) / 2,
    (112.70933354500005 + 112.691841) / 2,
  ],
  ['equator', 0, 0],
  ['antimeridian', -10, 179.9],
  ['high-latitude', 60, 10],
  ['far-south', -40, 35],
  ['bawean', -5.8, 112.65],
  ['kangean', -6.95, 115.4],
  ['banyuwangi-anchorage', -8.22, 114.39],
  ['gresik', -7.15, 112.65],
  ['probolinggo-offshore', -7.65, 113.25],
  ['pacitan-offshore', -8.3, 111.0],
  ['madura-north', -6.85, 113.3],
  ['sapudi', -7.05, 114.3],
];
const random = prng(20261121);
for (let i = 0; i < 40; i += 1) {
  points.push([`random-${i}`, -9.5 + random() * 5, 110 + random() * 7]);
}
const coast = points.map(([name, lat, lon]) => ({
  name,
  lat,
  lon,
  meters: findNearestCoastDistance(coastFile, lat, lon),
}));

const samples = [
  { sog: 0, cog: 0, hdg: 0 },
  { sog: 0.1, cog: 0, hdg: 511 },
  { sog: 0.3, cog: 15, hdg: 10 },
  { sog: 0.39, cog: 350, hdg: 355 },
  { sog: 0.4, cog: 100, hdg: 95 },
  { sog: 0.5, cog: 0, hdg: 0 },
  { sog: 2.3, cog: 180, hdg: 511 },
  { sog: 0.2, cog: 359, hdg: 1 },
  { sog: 0.05, cog: 200, hdg: 190 },
  { sog: 12.4, cog: 45.5, hdg: 44 },
];
const coastDistances = [0, 150, 210, 210.000001, 500, Infinity];
const predictions = [];
for (const current of samples) {
  for (const previous of [undefined, ...samples.slice(0, 6)]) {
    for (const coastDistanceM of coastDistances) {
      predictions.push({
        current,
        previous: previous ?? null,
        coastDistanceM: Number.isFinite(coastDistanceM)
          ? coastDistanceM
          : 'Infinity',
        predicted: calculatePredictedNavStatus(
          current,
          previous,
          coastDistanceM,
        ),
      });
    }
  }
}

const pairs = [
  [
    { lat: -7.2, lon: 112.73 },
    { lat: -7.2, lon: 112.73 },
  ],
  [
    { lat: -7.2, lon: 112.73 },
    { lat: -7.2000000005, lon: 112.73 },
  ],
  [
    { lat: -7.2, lon: 112.73 },
    { lat: -7.200000001, lon: 112.730000001 },
  ],
  [
    { lat: -7.2, lon: 112.73 },
    { lat: -7.2, lon: 112.7300009 },
  ],
  [
    { lat: -8.747773333333333, lon: 116.05734 },
    { lat: -8.747791666666666, lon: 116.057365 },
  ],
  [
    { lat: -7.2, lon: 112.73 },
    { lat: -7.25, lon: 112.8 },
  ],
  [
    { lat: 1.1, lon: 104.0 },
    { lat: -6.1, lon: 106.85 },
  ],
  [
    { lat: 0, lon: 179.9 },
    { lat: 0, lon: -179.9 },
  ],
  [
    { lat: -89.9, lon: 0 },
    { lat: 89.9, lon: 180 },
  ],
];
const haversine = pairs.map(([from, to]) => {
  const result = calculateDistance(from, to);
  return { from, to, nm: result.distance, meters: result.distanceInMeters };
});

/** One entry per line: compact and diff-friendly (the file is not Prettier-formatted). */
const lines = (entries) =>
  entries.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n');
writeFileSync(
  out,
  [
    '{',
    '  "generatedBy": "scripts/legacy-goldens.mjs (original be-legacy functions, turf 7.2.0)",',
    `  "coast": [\n${lines(coast)}\n  ],`,
    `  "predictions": [\n${lines(predictions)}\n  ],`,
    `  "haversine": [\n${lines(haversine)}\n  ]`,
    '}',
    '',
  ].join('\n'),
);
process.stdout.write(
  `${out}: ${coast.length} coast, ${predictions.length} prediction, ${haversine.length} haversine goldens\n`,
);
