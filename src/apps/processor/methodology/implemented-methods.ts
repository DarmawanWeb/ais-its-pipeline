/**
 * Ids of the methodology catalog methods this repository implements
 * (docs/references/methods.json, docs/PLATFORM_SPEC.md §17). Keep it in sync
 * with the `@method` TSDoc tags of the implementing functions and with the
 * README section "Methodology & references".
 */
export const IMPLEMENTED_METHOD_IDS: readonly string[] = [
  // Ingestor and processor: normalization, legacy position time, duplicate filter.
  'data.ais_ingest_rules',
  // Ingestor: ITU time-stamp reading (AIS_UTC_MODE=itu), plausibility window, utc diagnostic.
  'data.ais_position_time',
  // Ingestor: navstatus range and "not available" values of the validation.
  'navstatus.ais_codes',
  // Processor: legacy haversine of the duplicate filter (contracts implementation).
  'geo.haversine_distance',
  'geo.coast_distance',
  'data.indonesia_coastline',
  'navstatus.prediction',
  // Processor: track simplification of GET …/track?simplify= and …/pairs/track?simplify=.
  'geo.track_simplification',
];
