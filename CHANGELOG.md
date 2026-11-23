# Changelog

All notable changes to `ais-its-pipeline` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the repository adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-22

Upgrade to `@darmawanweb/ais-its-contracts` 0.4.0 and `@darmawanweb/ais-its-nest` 0.3.0: the
local workarounds for the kit problems this repository reported are gone (pin release on
shutdown, long pin TTL, CORS header patching, union-typed fleet envelopes, the test-peer strip of
`.pnpmfile.cjs`), the position events are relayed per vessel, and the backend gaps the web app
reported for the processor are closed.

### Added

- `GET /api/v2/ais/latest?mmsi=a,b,c` (or repeated `mmsi=`): batch lookup of the latest positions
  of up to 100 vessels (a page of a vessel list, "last seen"). Vessels never recorded are omitted;
  without `since` there is no age limit (the 24 h default applies only without `mmsi`); `since`,
  `bbox` and `limit` still filter. An MMSI that is not nine digits answers
  `400 VALIDATION_FAILED` (`field: 'mmsi'`, `code: 'isMmsi'`), more than 100 `arrayMaxSize`.
- `GET /api/v2/ais/pairs/track` takes `resolution=raw|1m` and `simplify` like the vessel track
  (same range limits per resolution, 100 000-point limit and `truncated` / `remainingTo` per
  track), so long encounters no longer ship every raw point; the default stays raw (legacy
  `/ais/routes`).
- `GET /api/v2/ais/stats/series?from&to&bucket=1m|5m|1h` (`ais:read`, API keys with `ais:read`):
  the history of `GET /ais/stats` as UTC-aligned buckets `{ at, samples, messages, activeVessels,
bySource: { primary, batam, pusher } }` with `from`, `to`, `bucket`, `bucketMinutes` and
  `activeWindowMinutes`. 1m: range ≤ 24 h (default the last hour); 5m: ≤ 7 days (24 h); 1h:
  ≤ 90 days (7 days). Coarser buckets add up the positions of their minutes and report the active
  vessels of their last sampled minute; buckets without samples are left out (gaps).
- `TrafficSampler` and migration `0005_traffic_minutes.sql`: every processor replica samples the
  counters of `GET /ais/stats` 5 s after each minute into the hypertable `traffic_minutes`
  (per minute and feed: `messages`, `active_vessels`; PK `(minute, source)`, `ON CONFLICT DO
NOTHING` so the first replica wins; kept 1 year), metric
  `aisits_ais_stats_samples_total{outcome="recorded|exists|failed"}`. A starting replica samples
  the minute that just ended only 5–15 s after its end (it waits for the 5 s mark, and leaves the
  minute to the others when it starts later).
- Migration `0004_outbox_per_key.sql`: the kit's `outboxUpgradeSql()` for the 0.2 table of
  `0003` (`seq`, `next_attempt_at`, the per-key indexes), after deleting the already published
  rows so the `seq` backfill (which locks the table until it commits) rewrites only pending ones.
- Variables `OUTBOX_POLL_INTERVAL_MS` (200), `OUTBOX_BATCH_SIZE` (500),
  `OUTBOX_PUBLISH_CONCURRENCY` (64), `OUTBOX_RETRY_BASE_MS` (1000), `OUTBOX_RETRY_MAX_MS`
  (30000), `OUTBOX_RETENTION_MINUTES` (10).
- When this instance becomes the active `ais-processor` (`ExclusiveConsumerListener`
  `onConsumerActivated`), its in-memory vessel states are dropped before the first report of the
  new pin (`VesselTracker.reset()`: cached states at once, entries with work in flight detached
  until it settled), so a failover or failback never decides on states another replica
  superseded. The Valkey revalidation of cached states stays as a defence.
- Methodology: `@method data.ais_position_time` on `ituPositionTime`, `utcSecondLag` and
  `positionTimeOf`, and the id in `IMPLEMENTED_METHOD_IDS` (`GET /ais/methodology`);
  `geo.track_simplification` is catalogued (contracts 0.4.0).
- Tests: the activation reset (unit), `parseMmsiList` and the query DTOs, the pair track
  options, the series assembly and the sampler (unit); the 0004 upgrade of a populated 0.2
  outbox and a failing vessel backing off alone in per-key mode
  (`test/outbox-upgrade.int.test.ts`); batch latest, pairs with `resolution` / `simplify`,
  the stats series, `@MmsiParam` field errors, the standby's activation on handover
  (integration).

### Changed

- **Dependencies**: `@darmawanweb/ais-its-contracts` ^0.4.0, `@darmawanweb/ais-its-nest` ^0.3.0;
  `.pnpmfile.cjs` is the template's (strips `@nestjs/swagger` → `typescript` and
  `@nestjs/terminus` → `@grpc/grpc-js`, `@grpc/proto-loader` from the production install; the
  kit no longer declares test packages as peers).
- **Outbox relay** (`OutboxModule.forRootAsync` from validated config instead of the static
  `POSITION_OUTBOX`): explicit `per-key` mode. Every replica relays (`FOR UPDATE SKIP LOCKED`, up
  to 64 vessels at once, each vessel's events in `seq` order); a publish that fails backs off that
  vessel only (equal-jitter 1–30 s) instead of stopping every vessel behind it. A table without
  the 0004 columns fails the start (`OutboxConfigError`) rather than falling back to the serial
  relay.
- **Exclusive consumer** `ais-processor`: pin TTL back to the kit's 30 s
  (`PROCESSOR_PINNED_TTL_MS = DEFAULT_PINNED_TTL_MS`, was 90 s): kit 0.3 pulls every TTL / 3 and
  keeps an idle instance pinned, so a crashed active replica is replaced within 30 s instead of
  90 s. A graceful stop still hands over at once (now the kit's `stop()`).
- `GET /ais/vessels/:mmsi/latest` and `/track` read `:mmsi` with the kit's `@MmsiParam()`:
  exactly nine digits (`0525005223`, `5250052e3` are rejected), `400 VALIDATION_FAILED` with
  `errors: [{ field: 'mmsi', code: 'isMmsi' }]`, documented as `pattern: ^[0-9]{9}$`.
- `X-Truncated` is exposed to cross-origin browsers through
  `bootstrapService({ cors: { exposedHeaders: ['X-Truncated'] } })` (`PROCESSOR_CORS`, also used
  by the tests); the kit's defaults now include `ETag` and `Location`.
- The FLEET projection is an exhaustive `switch` over the two fleet events
  (`ConsumerEnvelope<'ais-processor-fleet'>` is exact in contracts 0.4).
- `openapi.processor.json` / `openapi.ingestor.json` regenerated: the new routes and parameters,
  the kit's page maximum, MMSI parameter schemas, security schemes; version 0.2.0.
- `.env.example` documents `TRUSTED_PROXIES` for production (the gateway's address or CIDR only;
  the kit warns at boot while the default is in effect), the exposed CORS headers, traces-only
  tracing and the `OUTBOX_*` variables.

### Removed

- `src/apps/processor/pipeline/exclusive-consumer-handover.ts` (and its spec): the stop + unpin
  before shutdown that kit 0.2 lacked.
- `exposeHeader()` in `positions.controller.ts` (per-response patching of
  `Access-Control-Expose-Headers`).
- The `WORKAROUND(platform, contracts 0.3.0)` if-guards and the unreachable warn fallback of
  `fleet.projection.ts`.
- The `@darmawanweb/ais-its-nest` entry of `.pnpmfile.cjs`; `MmsiParamDto`; the "proposed id"
  remarks of `geo.track_simplification`.

### Upgrade notes

- Deploy after notification (platform rollout order); nothing here depends on it.
- The boot applies `0004` and `0005` (`pnpm migrate` when `DB_MIGRATE_ON_BOOT=false`). `0004`
  locks `outbox` until it commits; published rows are deleted first, so it is short whenever the
  relay is keeping up.
- Rolling update: a 0.1.0 processor still relays in serial mode and never publishes at the same
  time as a 0.2.0 one (exclusive versus shared advisory lock). Both versions release the pin on a
  graceful stop (0.1.0 through its `ExclusiveConsumerHandover`), so the standby takes over at once.
  The first 0.2.0 processor to start lowers the pin TTL of the shared durable `ais-processor` from
  90 s to 30 s in place (`Consumer updated (priority)`), for every instance; a 0.1.0 processor
  starting again (a rollback) raises it back to 90 s. A crashed active instance of either version
  is replaced once the TTL in effect lapses.
- The `GET /ais/stats/series` history starts with the first 0.2.0 processor.
- Set `TRUSTED_PROXIES` to the gateway in production and `max_payload: 4MB` on NATS (the kit
  warns at boot otherwise).

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
