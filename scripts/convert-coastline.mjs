// Converts the legacy coast geometry (be-legacy/data/indonesia.json) into
// data/coastline.geojson, the file the processor loads once at startup
// (GEO_COASTLINE_PATH). Coordinates are copied unchanged (JSON numbers
// round-trip exactly), so coast distances keep legacy parity; only
// provenance properties are added (methodology id data.indonesia_coastline).
//
//   node scripts/convert-coastline.mjs <legacy indonesia.json> [out]
import { readFileSync, writeFileSync } from 'node:fs';

const [source, out = 'data/coastline.geojson'] = process.argv.slice(2);
if (source === undefined) {
  process.stderr.write(
    'usage: node scripts/convert-coastline.mjs <indonesia.json> [out]\n',
  );
  process.exit(2);
}

const legacy = JSON.parse(readFileSync(source, 'utf8'));
if (legacy.type !== 'FeatureCollection' || !Array.isArray(legacy.features)) {
  throw new Error(`${source} is not a GeoJSON FeatureCollection`);
}

const features = legacy.features.map((feature) => ({
  type: 'Feature',
  properties: {
    ...feature.properties,
    methodId: 'data.indonesia_coastline',
    provenance:
      'Legacy MVP be-legacy/data/indonesia.json (simplified Jawa Timur province boundary, ' +
      'KODE_PROV 35; outer rings only). Origin and licence unverified: needs citation from the thesis.',
  },
  geometry: feature.geometry,
}));

writeFileSync(
  out,
  `${JSON.stringify({ type: 'FeatureCollection', features })}\n`,
);
process.stdout.write(`${out}: ${features.length} feature(s)\n`);
