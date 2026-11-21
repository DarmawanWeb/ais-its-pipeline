/**
 * Ids of the methodology catalog methods this repository implements
 * (docs/references/methods.json, docs/PLATFORM_SPEC.md §17). Keep it in sync
 * with the `@method` TSDoc tags of the implementing functions and with the
 * README section "Methodology & references".
 */
export const IMPLEMENTED_METHOD_IDS: readonly string[] = [
  // Ingestor and processor: normalization, position time, duplicate filter.
  'data.ais_ingest_rules',
  // Ingestor: navstatus range and "not available" values of the validation.
  'navstatus.ais_codes',
  // Processor: legacy haversine of the duplicate filter (contracts implementation).
  'geo.haversine_distance',
  'geo.coast_distance',
  'data.indonesia_coastline',
  'navstatus.prediction',
  // Proposed id (not in the catalog yet): track simplification of GET …/track?simplify=.
  'geo.track_simplification',
];
