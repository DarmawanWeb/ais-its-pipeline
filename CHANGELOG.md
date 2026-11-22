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
    or a batch ≤ 1000, acknowledged) with a per-connection token bucket; the key is re-checked on
    every event: a refused key disconnects, an unavailable introspection keeps the socket open
    (last verified key for `INGEST_SOCKET_AUTH_GRACE_S`, then retryable `SERVICE_UNAVAILABLE` acks);
  - `POST /api/v2/ingest/ais` (API key `ais:ingest`; legacy or normalized format, single or
    array ≤ 1000) → `202 { accepted, rejected, errors[] }`;
  - `GET /api/v2/ingest/status` (super_admin): feed states, reconnects, pushers and rates;
  - normalization with legacy parity (`positionTime = timestamp − utc` seconds; opt-in ITU-R
    M.1371 time-stamp reading `AIS_UTC_MODE=itu` and the diagnostic
    `aisits_ais_utc_second_lag_seconds`) and validation (missing fields, lat 91 / lon 181 not
    available, out-of-range values, 9-digit MMSI, position times > 5 min in the future, before
    1970 or older than `INGEST_MAX_POSITION_AGE_S` (`STALE_TIMESTAMP`), every report checked
    against the `ais.raw.received.v1` schema so it is rejected on its own instead of failing its
    batch); `ais.raw.received.v1` with `Nats-Msg-Id = <mmsi>:<positionTime>:<source>`; the
    ingestor ensures the stream `AIS_RAW`.
- **Processor** (`node dist/apps/processor/main.js`, port 3004, schema `ais`):
  - durable consumer `ais-processor` on `AIS_RAW`, exclusive with a 90 s pin TTL (an idle
    instance stays pinned) and a pin release on graceful shutdown (standby takes over at once);
    last position per vessel in an in-memory LRU, revalidated against the Valkey hash
    `ais:last:<mmsi>` before use (database fallback), saved monotonically (Lua);
  - duplicate-movement filter against the **latest** position (`AIS_DEDUP_MIN_DISTANCE_M`, spec
    §15.1), out-of-order reports stored without touching the latest state or linking `previous`;
  - `predictedNavstatus` (exact port of legacy `calculatePredictedNavStatus`) and the coast
    distance (bit-identical to legacy `findNearestCoastDistance` / turf 7.2.0) over
    `data/coastline.geojson` (legacy `data/indonesia.json`) loaded once and indexed with flatbush;
  - batched, idempotent writes (`PROCESSOR_BATCH_SIZE`, `PROCESSOR_FLUSH_MS`), one transaction
    per batch resolved against the stored latest positions under lock: hypertable
    `ais.positions` (compression after 3 days, retention 180 days, `ON CONFLICT DO NOTHING`),
    `ais.vessel_latest` (never regresses) and the transactional outbox (migration `0003`);
    continuous aggregate `ais.positions_1m` (refresh every minute, compression after 7 days,
    retention 5 years; migration `0002` re-runnable after a partial apply);
  - `ais.position.recorded.v1` with `previous` (deterministic event ids), enqueued with its rows
    and published to `AIS_POSITION` by the kit's outbox relay — a committed position never loses
    its event;
  - FLEET projection `ais.vessel_refs` (durable `ais-processor-fleet`) enriching responses with
    vessel id, name and type code;
  - query API (`ais:read`, API keys with `ais:read`): `GET /api/v2/ais/latest` (bbox, since,
    limit, `X-Truncated` header; p95 < 200 ms with 10 000 vessels), `GET /api/v2/ais/vessels/:mmsi/latest`,
    `GET /api/v2/ais/vessels/:mmsi/track` (raw / 1m, Douglas–Peucker simplification; beyond
    100 000 points the newest are kept, with `truncated` and `remainingTo`),
    `GET /api/v2/ais/pairs/track`, `GET /api/v2/ais/stats`, `GET /api/v2/ais/methodology`.
- Domain metrics `aisits_ais_messages_total{source,outcome}`, `aisits_ais_ingest_lag_seconds` and
  feed, pusher (incl. auth outages), writer, state-cache (loads, revalidations, stale decisions,
  Valkey errors) and outbox metrics.
- Golden tests from the original legacy functions (`scripts/legacy-goldens.mjs`), integration
  tests against TimescaleDB/PostGIS, NATS and Valkey containers, two OpenAPI documents
  (`openapi.ingestor.json`, `openapi.processor.json`), Docker image (default command: processor;
  test-only peers of the kit kept out of the production dependencies), CI and release workflows.

[0.1.0]: https://github.com/DarmawanWeb/ais-its-pipeline/releases/tag/v0.1.0
