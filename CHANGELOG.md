# Changelog

All notable changes to `ais-its-pipeline` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the repository adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-21

First release of the AIS pipeline of AIS Maritime Intelligence v2 (docs/PLATFORM_SPEC.md §13.2):
one repository and image, two processes.

### Added

- **Ingestor** (`node dist/apps/ingestor/main.js`, port 3003, stateless):
  - socket.io clients of the upstream servers `primary` and `batam` (`AIS_PRIMARY_URL`,
    `AIS_BATAM_URL`, `AIS_UPSTREAM_TOKEN`; event `messageFromServer`, legacy
    `TimestampedAisMessage`), reconnection with exponential backoff and jitter, per-feed status
    and metrics; a feed is disabled by leaving its URL empty;
  - socket.io endpoint for pushers at `/api/v2/ingest/socket` (handshake `auth: { apiKey }` with
    scope `ais:ingest`, introspected through the auth service; event `ais:data` with one message
    or a batch ≤ 1000, acknowledged) with a per-connection token bucket;
  - `POST /api/v2/ingest/ais` (API key `ais:ingest`; legacy or normalized format, single or
    array ≤ 1000) → `202 { accepted, rejected, errors[] }`;
  - `GET /api/v2/ingest/status` (super_admin): feed states, reconnects, pushers and rates;
  - normalization with legacy parity (`positionTime = timestamp − utc` seconds) and validation
    (missing fields, lat 91 / lon 181 not available, out-of-range values, 9-digit MMSI, position
    times > 5 min in the future); `ais.raw.received.v1` with
    `Nats-Msg-Id = <mmsi>:<positionTime>:<source>`; the ingestor ensures the stream `AIS_RAW`.
- **Processor** (`node dist/apps/processor/main.js`, port 3004, schema `ais`):
  - durable consumer `ais-processor` (exclusive) on `AIS_RAW`; last position per vessel in an
    in-memory LRU in front of the Valkey hash `ais:last:<mmsi>` (database fallback);
  - duplicate-movement filter against the **latest** position (`AIS_DEDUP_MIN_DISTANCE_M`, spec
    §15.1), out-of-order reports stored without touching the latest state or linking `previous`;
  - `predictedNavstatus` (exact port of legacy `calculatePredictedNavStatus`) and the coast
    distance (bit-identical to legacy `findNearestCoastDistance` / turf 7.2.0) over
    `data/coastline.geojson` (legacy `data/indonesia.json`) loaded once and indexed with flatbush;
  - batched, idempotent writes (`PROCESSOR_BATCH_SIZE`, `PROCESSOR_FLUSH_MS`): hypertable
    `ais.positions` (compression after 3 days, retention 180 days, `ON CONFLICT DO NOTHING`) and
    `ais.vessel_latest` (never regresses); continuous aggregate `ais.positions_1m` (refresh every
    minute, compression after 7 days, retention 5 years);
  - `ais.position.recorded.v1` with `previous` (deterministic event ids), stream `AIS_POSITION`;
  - FLEET projection `ais.vessel_refs` (durable `ais-processor-fleet`) enriching responses with
    vessel id, name and type code;
  - query API (`ais:read`, API keys with `ais:read`): `GET /api/v2/ais/latest` (bbox, since,
    limit; p95 < 200 ms with 10 000 vessels), `GET /api/v2/ais/vessels/:mmsi/latest`,
    `GET /api/v2/ais/vessels/:mmsi/track` (raw / 1m, Douglas–Peucker simplification),
    `GET /api/v2/ais/pairs/track`, `GET /api/v2/ais/stats`, `GET /api/v2/ais/methodology`.
- Domain metrics `aisits_ais_messages_total{source,outcome}`, `aisits_ais_ingest_lag_seconds` and
  feed, pusher, writer and state-cache metrics.
- Golden tests from the original legacy functions (`scripts/legacy-goldens.mjs`), integration
  tests against TimescaleDB/PostGIS, NATS and Valkey containers, two OpenAPI documents
  (`openapi.ingestor.json`, `openapi.processor.json`), Docker image (default command: processor),
  CI and release workflows.

[0.1.0]: https://github.com/DarmawanWeb/ais-its-pipeline/releases/tag/v0.1.0
