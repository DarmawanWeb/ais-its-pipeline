# ais-its-pipeline

AIS ingestion and processing of **AIS Maritime Intelligence** v2 (docs/PLATFORM_SPEC.md §13.2):
one repository, one image, **two processes** — the stateless **ingestor** (port 3003) that receives
AIS reports from upstream socket.io servers, pushers and REST and normalizes them into `AIS_RAW`,
and the **processor** (port 3004) that turns them into recorded positions (schema `ais`), keeps the
latest state per vessel and serves the AIS query API. NestJS 12 + Fastify on the platform kit
[`@darmawanweb/ais-its-nest`](https://github.com/DarmawanWeb/ais-its-contracts/tree/main/packages/nest),
PostgreSQL 17 + TimescaleDB + PostGIS, NATS JetStream, Valkey. The normative spec is
`docs/PLATFORM_SPEC.md` of the central repository
([`ais-its-platform`](https://github.com/DarmawanWeb/ais-its-platform)).

**AIS data only**: no safety or surveillance logic. The pipeline Early Warning System moved to the
safety service (§13.7), illegal transhipment and the navstatus anomaly to surveillance (§13.8),
voyage segments and CII to emission (§13.5); they all consume `ais.position.recorded.v1`.

## Responsibilities

| Process                                           | Does                                                                                                                                                                                                                                                                                                                                                                                  | Owns                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **ais-ingestor** (`dist/apps/ingestor/main.js`)   | socket.io clients of the upstream servers `primary` and `batam` (event `messageFromServer`, reconnect with backoff), socket.io endpoint for pushers (`ais:data`, API key, per-connection rate limit), `POST /api/v2/ingest/ais`, validation and normalization of legacy and flat reports, publication of `ais.raw.received.v1` (deduplicated by `Nats-Msg-Id`), feed status and rates | nothing persistent (stateless, no database); produces to the stream `AIS_RAW`      |
| **ais-processor** (`dist/apps/processor/main.js`) | durable consumer `ais-processor` on `AIS_RAW`: duplicate-movement filter, out-of-order handling, coast distance, predicted navstatus; batched writes of `ais.positions` and `ais.vessel_latest`; `ais.position.recorded.v1` with `previous`; FLEET projection for vessel names; the AIS query API                                                                                     | PostgreSQL schema `ais`, Valkey keys `ais:last:<mmsi>`; produces to `AIS_POSITION` |

## Architecture

```mermaid
flowchart LR
  P["primary upstream (socket.io)"] -->|messageFromServer| UF
  B["batam upstream (socket.io)"] -->|messageFromServer| UF
  PU["pushers (API key ais:ingest)"] -->|"ais:data /api/v2/ingest/socket"| PG
  PU -->|"POST /api/v2/ingest/ais"| IC
  subgraph ingestor["ais-ingestor :3003 (stateless)"]
    UF["UpstreamFeedsService"] --> N["normalizeAisMessage()"]
    PG["PusherGateway (token bucket)"] --> N
    IC["IngestController"] --> N
  end
  N -->|"ais.raw.received.v1 (Nats-Msg-Id mmsi:time:source)"| RAW[("AIS_RAW")]
  RAW -->|"durable ais-processor (exclusive)"| PP
  subgraph processor["ais-processor :3004 (schema ais)"]
    PP["PositionPipelineService: dedup, out-of-order, coast distance, navstatus"] --> BW["PositionWriter (500 rows / 1 s)"]
    FP["FleetProjection"]
    API["Query API /api/v2/ais/*"]
  end
  PP <-->|"ais:last:mmsi + LRU"| VK[("Valkey")]
  BW --> DB[("PostgreSQL ais.positions, vessel_latest, positions_1m")]
  PP -->|"ais.position.recorded.v1 + previous"| POS[("AIS_POSITION")]
  FLEET[("FLEET")] -->|"durable ais-processor-fleet"| FP --> DB
  API --> DB
  POS --> C["emission, safety, surveillance, notification"]
```

Each process follows the kit's lifecycle rule: connect, migrate and ensure streams (`onModuleInit`)
→ start upstream feeds and consumers (`onApplicationBootstrap`) → the port opens. On `SIGTERM`
readiness answers `503`, the upstream feeds and pushers close (ingestor), the consumers and the
write buffer drain (processor), NATS drains and the pool closes.

| Path                               | What                                                                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/apps/ingestor/`               | `main.ts` (telemetry → `server.ts`), `ingestor.module.ts`, `config.ts`, `ingest/`, `pusher/`, `upstream/`, `status/`                                                                   |
| `src/apps/processor/`              | `main.ts`, `processor.module.ts`, `config.ts`, `pipeline/` (consumer → service → writer, repositories), `positions/`, `stats/`, `fleet/`, `coastline/`, `methodology/`, `db/schema.ts` |
| `src/shared/domain/`               | pure functions with `@method` TSDoc and golden tests: `normalize.ts`, `movement.ts`, `navstatus.ts`, `coastline.ts`, `simplify.ts`, `event-id.ts`                                      |
| `src/shared/service.ts`            | identity of the repository and of both processes (names, ports, schema, version from `package.json`)                                                                                   |
| `src/openapi.ts`, `src/migrate.ts` | `pnpm openapi` (both documents, no infrastructure) and `pnpm migrate`                                                                                                                  |
| `migrations/`                      | forward-only SQL of the schema `ais`                                                                                                                                                   |
| `data/coastline.geojson`           | coast geometry (legacy `data/indonesia.json`, `scripts/convert-coastline.mjs`)                                                                                                         |
| `scripts/legacy-goldens.mjs`       | regenerates the golden values by running the original legacy functions                                                                                                                 |
| `test/`                            | integration tests `*.int.test.ts` (testcontainers), `test/support/` (shared containers, app factories)                                                                                 |

### Processing rules (processor)

For every raw report, in arrival order per vessel (one handler per message, `concurrency` 1024,
per-vessel FIFO in `VesselTracker`):

1. **State**: the vessel's latest position comes from the in-memory LRU (`AIS_STATE_CACHE_SIZE`),
   else the Valkey hash `ais:last:<mmsi>`, else `ais.vessel_latest` (cold Valkey). A failure
   retries the message rather than processing it without history.
2. **Classification** against the **latest** position (`classifyMovement`): no state → recorded;
   newer and moved ≥ `AIS_DEDUP_MIN_DISTANCE_M` (legacy haversine, R = 3438 nm) → recorded; newer
   and moved less → skipped (`stationary`); same position time and position → duplicate (waits for
   the original's commit); same time, other position → `conflict` (dropped, the primary key keeps
   the first); **older** than the latest → `out_of_order`: stored in `ais.positions` for the track,
   but it never replaces the latest state, never gets an event and never becomes a `previous`.
3. **Enrichment** of recorded reports: `coastDistanceM` (exact turf 7.2.0 parity over the coast
   geometry loaded once and indexed with flatbush) and `predictedNavstatus` (legacy
   `calculatePredictedNavStatus(current, previous = latest position, coastDistanceM)`; a first
   report is its own previous, as legacy "CASE 1").
4. **Write**: rows are group-committed by `PositionWriter` (≤ `PROCESSOR_BATCH_SIZE` rows per
   transaction, a row waits ≤ `PROCESSOR_FLUSH_MS`): `INSERT … ON CONFLICT (mmsi, time) DO NOTHING`
   into `positions` and the `vessel_latest` upsert guarded by `WHERE vessel_latest.time < EXCLUDED.time`,
   in one transaction (deadlocks retried).
5. **Publish** `ais.position.recorded.v1` with `previous` (envelope id and `Nats-Msg-Id` derived from
   `(mmsi, time)`), then save `ais:last:<mmsi>` — in decision order per vessel.
6. **Ack** only after 4–5 succeeded; any failure naks the message (backoff, DLQ after 10
   deliveries) and resets the vessel's in-memory state. Every step is idempotent, so redeliveries and
   a full replay of `AIS_RAW` into a fresh consumer change nothing (integration-tested).

The consumer is `exclusive` (NATS ≥ 2.11 pinned client): one processor replica is active, others
stand by and take over. The query API is served by every replica.

## Data model (schema `ais`)

| Object                   | Kind                                                                                                                                                       | Columns / content                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `positions`              | hypertable on `time` (1-day chunks), PK `(mmsi, time)`; compressed after **3 days** (`segmentby mmsi`, `orderby time DESC`), retention **180 days**        | `time, mmsi, source, geom geography(Point,4326), sog, cog, hdg, navstatus, pred_navstatus, coast_dist_m` — every recorded report, out-of-order ones included       |
| `vessel_latest`          | table, PK `mmsi`; GiST on `geom::geometry`, index on `time DESC`                                                                                           | latest position per vessel (`time, source, lat, lon, geom, sog, cog, hdg, navstatus, pred_navstatus, coast_dist_m, updated_at`); never replaced by an older report |
| `vessel_refs`            | table, PK `mmsi`, unique `vessel_id` (FLEET projection)                                                                                                    | `mmsi → vessel_id, name, type_code, updated_at` (snapshot `updatedAt`; older snapshots ignored)                                                                    |
| `positions_1m`           | continuous aggregate (real-time, `materialized_only = false`); refreshed every minute over the last 2 days; compressed after 7 days; retention **5 years** | per vessel and minute: last `geom, sog, cog, hdg, navstatus, pred_navstatus, source`, `sog_avg`, `sog_max`, `samples`, `last_time`                                 |
| `schema_migrations`      | kit migrator                                                                                                                                               | applied migrations with checksums                                                                                                                                  |
| Valkey `ais:last:<mmsi>` | hash, TTL `AIS_STATE_TTL_DAYS`                                                                                                                             | `mmsi, time, source, lat, lon, sog, cog, hdg, navstatus, pred, coast` of the last committed position                                                               |

Drizzle definitions: `src/apps/processor/db/schema.ts` (mirror of `migrations/*.sql`).

## API

Routes live under `/api/v2`; errors are RFC 9457 problem details. The gateway routes
`/api/v2/ingest` (including the socket.io path) to the ingestor and `/api/v2/ais` to the processor.

| Process   | Method    | Path                                                                                                                                                          | Permission                                                              |
| --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| ingestor  | `POST`    | `/api/v2/ingest/ais` — one message or an array (≤ 1000), legacy or normalized → `202 { accepted, rejected, errors[] }`                                        | 🔑 API key scope `ais:ingest`; users: `super_admin` only (manual tests) |
| ingestor  | socket.io | path `/api/v2/ingest/socket`, event `ais:data` (legacy format, single or array ≤ 1000, ack `{ accepted, rejected, errors, error? }`)                          | 🔑 handshake `auth: { apiKey }` with scope `ais:ingest`                 |
| ingestor  | `GET`     | `/api/v2/ingest/status` — upstream states, reconnects, pushers, rates per feed                                                                                | `super_admin`                                                           |
| processor | `GET`     | `/api/v2/ais/latest?bbox=minLon,minLat,maxLon,maxLat&since=&limit=` → `VesselLatestDto[]` (default since 24 h ago, limit 10 000 ≤ 50 000, newest first)       | `ais:read`; 🔑 `ais:read`                                               |
| processor | `GET`     | `/api/v2/ais/vessels/:mmsi/latest` (`404 AIS_POSITION_NOT_FOUND`)                                                                                             | `ais:read`; 🔑 `ais:read`                                               |
| processor | `GET`     | `/api/v2/ais/vessels/:mmsi/track?from&to&resolution=raw\|1m&simplify=` (default last 24 h; raw ≤ 7 d, 1m ≤ 90 d; `simplify` = Douglas–Peucker tolerance in m) | `ais:read`; 🔑 `ais:read`                                               |
| processor | `GET`     | `/api/v2/ais/pairs/track?mmsi1&mmsi2&from&to` (raw tracks, legacy `/ais/routes/:mmsi1/:mmsi2`)                                                                | `ais:read`; 🔑 `ais:read`                                               |
| processor | `GET`     | `/api/v2/ais/stats` → `{ activeVessels, messagesLastMinute, bySource, activeWindowMinutes, at }`                                                              | `ais:read`; 🔑 `ais:read`                                               |
| processor | `GET`     | `/api/v2/ais/methodology` — catalog methods implemented by this repository                                                                                    | any signed-in user                                                      |
| both      | `GET`     | `/health/live`, `/health/ready`, `/metrics`, `/docs`, `/openapi.json` (outside the prefix, not exposed by the gateway)                                        | public                                                                  |

`VesselLatestDto = { mmsi, time, lat, lon, sog, cog, hdg, navstatus, predictedNavstatus, source,
vessel?: { id, name, typeCode } }`. AIS data is shared across tenants (spec §8.5): no org filter.

**OpenAPI: two documents.** Each process serves its own document at `/openapi.json`; `pnpm openapi`
writes both to the repository root — `openapi.ingestor.json` (tag `ingest`) and
`openapi.processor.json` (tags `ais`, `methodology`) — and `pnpm openapi:check` (CI) fails when
one is stale. Clients are generated per process (the web app needs only the processor's).

## Events

| Direction | Subject                                                       | Type                                                  | Stream               | Producer / consumer                          | Notes                                                                       |
| --------- | ------------------------------------------------------------- | ----------------------------------------------------- | -------------------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| publishes | `ais.raw.v1.<source>` (`primary`, `batam`, `pusher`)          | `ais.raw.received.v1`                                 | `AIS_RAW` (24 h)     | ais-ingestor (ensures the stream: producer)  | `Nats-Msg-Id = <mmsi>:<positionTime>:<source>` (2-min dedup window)         |
| consumes  | `ais.raw.v1.>`                                                | `ais.raw.received.v1`                                 | `AIS_RAW`            | durable **`ais-processor`** (exclusive)      | ack after commit + publish; out-of-order and duplicates handled as above    |
| publishes | `ais.position.v1.<mmsi % 16>.<mmsi>` (`subjects.aisPosition`) | `ais.position.recorded.v1`                            | `AIS_POSITION` (7 d) | ais-processor (ensures the stream: producer) | includes `previous`, no safety fields; deterministic id from `(mmsi, time)` |
| consumes  | `fleet.vessel.v1.>`                                           | `fleet.vessel.upserted.v1`, `fleet.vessel.deleted.v1` | `FLEET`              | durable **`ais-processor-fleet`**            | projection `ais.vessel_refs`                                                |

Downstream durable consumers of `AIS_POSITION`: `emission-positions`, `safety-positions`,
`surveillance-positions`; notification uses ordered consumers.

## Configuration

Both processes extend the kit's base schema (spec §4) and refuse to start on invalid values,
printing every problem. Empty values mean "unset". `SERVICE_NAME` and `PORT` default per process,
so one `.env` serves both (`.env.example` lists every variable).

| Variable                                              | Process   | Default                                                            | Meaning                                                                                  |
| ----------------------------------------------------- | --------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `SERVICE_NAME`                                        | both      | `ais-ingestor` / `ais-processor`                                   | logs, metrics, event `source`                                                            |
| `SERVICE_VERSION`                                     | both      | `package.json` version                                             |                                                                                          |
| `PORT` / `HOST`                                       | both      | `3003` / `3004`, `0.0.0.0`                                         |                                                                                          |
| `NODE_ENV`                                            | both      | `development`                                                      | `development` \| `test` \| `production`                                                  |
| `LOG_LEVEL` / `LOG_PRETTY`                            | both      | `info` / `true` in development                                     | pino                                                                                     |
| `SHUTDOWN_TIMEOUT_MS`                                 | both      | `30000`                                                            | graceful shutdown deadline                                                               |
| `NATS_URL`                                            | both      | `nats://localhost:4222`                                            | comma separated list allowed                                                             |
| `NATS_DURABLE_PREFIX`                                 | both      | empty                                                              | prefix of durable names (tests)                                                          |
| `AUTH_JWKS_URL`                                       | both      | `http://localhost:3001/.well-known/jwks.json`                      | access-token keys                                                                        |
| `AUTH_ISSUER` / `AUTH_AUDIENCE`                       | both      | `ais-its-auth` / `ais-its-api`                                     |                                                                                          |
| `AUTH_INTERNAL_URL`                                   | both      | `http://localhost:3001`                                            | API-key introspection (`ais:ingest`, `ais:read`), cached 60 s                            |
| `INTERNAL_TOKEN`                                      | both      | `dev-internal-token-change-me`                                     | `X-Internal-Token` of the introspection; ≥ 16 chars and not the default in production    |
| `CORS_ORIGINS`                                        | both      | `http://localhost:5173,http://localhost:8000`                      |                                                                                          |
| `TRUSTED_PROXIES`                                     | both      | `loopback,linklocal,uniquelocal`                                   | proxies whose `X-Forwarded-For` is trusted                                               |
| `PUBLIC_BASE_URL`                                     | both      | `http://localhost:8000`                                            | (kit; not used by this repository)                                                       |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                         | both      | unset                                                              | OTLP/HTTP tracing when set                                                               |
| `AIS_PRIMARY_URL`                                     | ingestor  | unset = feed disabled                                              | primary upstream socket.io server (`http`, `https`, `ws`, `wss`)                         |
| `AIS_BATAM_URL`                                       | ingestor  | unset = feed disabled                                              | Batam upstream socket.io server                                                          |
| `AIS_UPSTREAM_TOKEN`                                  | ingestor  | unset                                                              | handshake `auth.token` sent to both upstreams                                            |
| `AIS_UPSTREAM_RECONNECT_MIN_MS` / `_MAX_MS`           | ingestor  | `1000` / `30000`                                                   | reconnection backoff: doubling from min to max, ±50 % jitter                             |
| `INGEST_SOCKET_RATE_PER_S`                            | ingestor  | `200`                                                              | sustained messages per second of one pusher connection                                   |
| `INGEST_SOCKET_BURST`                                 | ingestor  | `2000`                                                             | token-bucket capacity of one pusher connection                                           |
| `INGEST_MAX_PENDING_PUBLISHES`                        | ingestor  | `10000`                                                            | upstream reports awaiting their JetStream ack before new ones are dropped (backpressure) |
| `DATABASE_URL`                                        | processor | (required) e.g. `postgres://ais_svc:ais_svc@localhost:5432/aisits` | role `ais_svc` from `infra/postgres/bootstrap.sql`                                       |
| `DATABASE_SCHEMA`                                     | processor | `ais`                                                              | `search_path=ais,public`                                                                 |
| `DATABASE_POOL_MAX` / `DATABASE_STATEMENT_TIMEOUT_MS` | processor | `10` / `30000`                                                     |                                                                                          |
| `DB_MIGRATE_ON_BOOT`                                  | processor | `true`                                                             | apply `migrations/` at startup (also `pnpm migrate`)                                     |
| `REDIS_URL`                                           | processor | `redis://localhost:6379`                                           | Valkey (`ais:last:<mmsi>`)                                                               |
| `AIS_DEDUP_MIN_DISTANCE_M`                            | processor | `0.1`                                                              | duplicate-movement threshold against the latest position [m]                             |
| `GEO_COASTLINE_PATH`                                  | processor | `<package>/data/coastline.geojson`                                 | coast geometry, loaded once at startup (a missing or invalid file stops the boot)        |
| `PROCESSOR_BATCH_SIZE`                                | processor | `500`                                                              | most rows per write transaction                                                          |
| `PROCESSOR_FLUSH_MS`                                  | processor | `1000`                                                             | longest a row waits for its transaction [ms]                                             |
| `AIS_STATE_CACHE_SIZE`                                | processor | `100000`                                                           | vessels cached in memory in front of Valkey                                              |
| `AIS_STATE_TTL_DAYS`                                  | processor | `30`                                                               | lifetime of `ais:last:<mmsi>` after the last recorded position                           |

## Local development

Requirements: Node.js 24 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker. `@darmawanweb/*` come
from GitHub Packages: map the scope once in `~/.npmrc` (never in this repository).

```bash
pnpm install
cp .env.example .env
pnpm --dir <central repo> infra:up   # postgres (bootstrap.sql: role ais_svc, schema ais), nats, valkey, …
pnpm dev:processor                   # :3004, migrates on boot (or: pnpm build && pnpm migrate)
pnpm dev:ingestor                    # :3003 (second terminal); set AIS_PRIMARY_URL / AIS_BATAM_URL to use upstreams
pnpm build && pnpm start:processor   # production build (start:ingestor likewise)
```

Push a report (API key with `ais:ingest` from `pnpm seed:demo` of the auth service):

```bash
curl -s -X POST localhost:3003/api/v2/ingest/ais -H "x-api-key: $AIS_INGEST_KEY" \
  -H 'content-type: application/json' \
  -d '{"message":{"data":{"valid":true,"aistype":1,"mmsi":"525005141","navstatus":0,"lat":-8.7477,"lon":116.0573,"sog":0.1,"cog":0,"hdg":511,"utc":0},"port":"COM3"},"timestamp":"2026-11-21T10:00:00Z"}'
# {"accepted":1,"rejected":0,"errors":[]}
curl -s 'localhost:3004/api/v2/ais/latest?bbox=95,-11,141,6' -H "x-api-key: $AIS_READ_KEY"
```

A socket.io pusher:

```js
import { io } from 'socket.io-client';
const socket = io('http://localhost:3003', {
  path: '/api/v2/ingest/socket',
  transports: ['websocket'],
  auth: { apiKey: process.env.AIS_INGEST_KEY },
});
const ack = await socket.emitWithAck('ais:data', [
  timestampedAisMessage /* , … ≤ 1000 */,
]);
// { accepted, rejected, errors: [{ index, code, field, message }], error?: { code: 'RATE_LIMITED', retryAfterMs } }
```

Swagger UI: `http://localhost:3003/docs` and `http://localhost:3004/docs`.

## Testing

```bash
pnpm test        # unit: src/**/*.spec.ts (619 tests: normalization, golden parity, dedup/out-of-order, writer, codecs, …)
pnpm test:int    # integration: test/*.int.test.ts against TimescaleDB/PostGIS, NATS and Valkey containers
```

| File                                  | Covers                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/ingestor-rest.int.test.ts`      | `POST /ingest/ais` with fake API-key introspection (scopes, users, mixed batches, `Nats-Msg-Id`, re-sent batches, > 1000), status, metrics, readiness                                                                                                                           |
| `test/ingestor-socket.int.test.ts`    | upstream clients against local socket.io servers (token, both feeds, invalid reports, reconnect after server disconnect and restart), pusher handshake refusals, `ais:data` acks, token bucket                                                                                  |
| `test/pipeline.int.test.ts`           | migrations and Timescale policies, raw → `positions` / `vessel_latest` / Valkey / `ais.position.recorded.v1` with `previous`, duplicate movement, out-of-order, coast-distance and navstatus parity end to end, idempotent replay, Valkey → database fallback, FLEET projection |
| `test/query-api.int.test.ts`          | permissions (users, `ais:read` keys), latest with `bbox`/`since`/`limit`, vessel latest and 404, raw / 1m / simplified tracks, range limits, pairs, stats, methodology, OpenAPI paths                                                                                           |
| `test/latest-performance.int.test.ts` | `GET /ais/latest` over HTTP with **10 000 vessels**: p95 < 200 ms (three runs on the shared 4-CPU build VM: p50 58–97 ms, **p95 78–170 ms** for all 10 000 vessels (2.1 MB); bbox and `since` queries p95 18–110 ms)                                                            |

Golden values (`src/shared/domain/__fixtures__/legacy-goldens.json`: 65 coast distances, 420
predictions, 9 haversine distances) come from running the **original legacy functions** once
(`pnpm data:goldens <be-legacy>`, turf 7.2.0 as in the legacy lockfile); the coast distance matches
them bit for bit. The integration tests share one set of containers (`test/support/global-setup.ts`,
`TESTCONTAINERS_RYUK_DISABLED=true`), reset the schema `ais` and purge `AIS_RAW`/`AIS_POSITION` per file.

## Operations

- **Image**: `ghcr.io/darmawanweb/ais-its-pipeline`, built once, default command = processor.
  Ingestor: same image, command `node dist/apps/ingestor/main.js` (compose
  `command: ["node", "dist/apps/ingestor/main.js"]`). `HEALTHCHECK` probes `/health/live` on
  `PORT`, else 3004 then 3003. Build on the VM:
  `DOCKER_BUILDKIT=1 docker build --network host --secret id=npmrc,src=$HOME/.npmrc --secret id=ca,src=/root/.ccr/ca-bundle.crt -t ais-its-pipeline .`
- **Health**: `/health/live` (process up); `/health/ready` — ingestor: `nats`; processor:
  `database`, `nats`, `redis`. Readiness turns `503` on shutdown and when a consumer stalls.
- **Scaling**: ingestors scale horizontally (duplicates across replicas or feeds are dropped by
  `Nats-Msg-Id`); each ingestor connects to the upstreams, so run one per upstream account or
  disable feeds per replica by leaving their URL empty. The processor consumer is exclusive (one active
  replica, hot standbys); the query API scales with replicas.
- **Metrics** (`/metrics`, prefix `aisits_`), besides the kit's HTTP/event metrics:

  | Metric                                                                   | Process   | Labels / meaning                                                                                  |
  | ------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------- |
  | `aisits_ais_messages_total`                                              | ingestor  | `source`, `outcome` = `published`, `duplicate`, `rejected`, `failed`, `dropped`, `rate_limited`   |
  | `aisits_ais_messages_total`                                              | processor | `source`, `outcome` = `recorded`, `stationary`, `duplicate`, `conflict`, `out_of_order`, `failed` |
  | `aisits_ais_ingest_lag_seconds`                                          | processor | histogram: position time → recorded and published                                                 |
  | `aisits_ais_rejections_total`                                            | ingestor  | `source`, `code` (validation reason)                                                              |
  | `aisits_ais_upstream_connected`                                          | ingestor  | `source`: 1 while connected                                                                       |
  | `aisits_ais_upstream_reconnects_total`                                   | ingestor  | `source`                                                                                          |
  | `aisits_ais_pusher_connections`                                          | ingestor  | open socket.io pusher connections                                                                 |
  | `aisits_ais_publish_pending`                                             | ingestor  | upstream reports awaiting their JetStream ack                                                     |
  | `aisits_ais_write_batch_rows`, `aisits_ais_write_batch_duration_seconds` | processor | rows and duration per write transaction                                                           |
  | `aisits_ais_state_loads_total`                                           | processor | `origin` = `valkey`, `database`, `none` (in-memory cache misses)                                  |

- **Troubleshooting**
  - _No positions recorded_: `GET /api/v2/ingest/status` (super_admin) shows each feed's state,
    `lastError` and per-minute rates; `aisits_ais_rejections_total{code}` tells why reports are
    rejected (e.g. `FUTURE_TIMESTAMP` for an upstream clock ahead by > 5 min, `INVALID_MMSI`).
  - _Upstream connected but nothing published_: `aisits_ais_messages_total{outcome="dropped"}`
    grows when NATS does not acknowledge (`aisits_ais_publish_pending` at its maximum).
  - _Processor lag_: `aisits_ais_ingest_lag_seconds`, the `ais-processor` consumer's pending count
    (`nats consumer info AIS_RAW ais-processor`) and `aisits_ais_write_batch_duration_seconds`;
    a standby replica takes over when the active one stops pulling.
  - _Many `stationary` outcomes_: expected for vessels at anchor (the legacy duplicate filter).
  - _Boot fails with `CoastlineFormatError` or ENOENT_: `GEO_COASTLINE_PATH` must point to a GeoJSON
    FeatureCollection of (Multi)Polygons.
  - _Messages in `dlq.AIS_RAW.ais-processor`_: a report failed 10 times (database or Valkey down);
    fix the cause and republish them.

## Legacy parity notes

| Legacy (be-legacy)                                                                                                 | v2                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/ws.ts`, `ws-batam.ts`: socket.io clients, `auth.token`, websocket transport, `messageFromServer`           | same protocol and payload (`TimestampedAisMessage`); reconnection with backoff, per-feed status and metrics; Batam = `source: 'batam'` (legacy `isBatam`)                                       |
| `config/ws-server.ts`: `ais:data` without authentication                                                           | API key with `ais:ingest` in the handshake (spec §15.6), batches ≤ 1000, acknowledgements, per-connection rate limit                                                                            |
| `createOrUpdateAis`: drop on missing `mmsi/navstatus/lat/lon/sog/cog/hdg`; time = `timestamp − utc` (`setSeconds`) | identical rules and arithmetic (`legacyPositionTime`); additionally rejects lat 91 / lon 181, out-of-range values, MMSIs without 9 digits (spec §13.2) and position times > 5 min in the future |
| duplicate filter: < 0.1 m from the **oldest** stored position (bug)                                                | < `AIS_DEDUP_MIN_DISTANCE_M` from the **latest** position (spec §15.1)                                                                                                                          |
| `calculatePredictedNavStatus(current, positions[0], minDistance)`; new vessel = current twice                      | exact port incl. the first-report rule, no 360° wrap, HDG 511; golden-tested on 420 legacy cases                                                                                                |
| `findNearestCoastDistance('data/indonesia.json', …)` read the file per message                                     | same geometry (`data/coastline.geojson`, coordinates unchanged), loaded once, flatbush-indexed, bit-identical distances (65 goldens); no geometry → `null` instead of `Infinity`                |
| positions kept 24 h inside the vessel document, newest first                                                       | `ais.positions` hypertable (180 d raw, 5 y 1-minute aggregate); out-of-order reports are kept and never become "latest"                                                                         |
| `GET /ais` (24 h), `GET /ais/:mmsi`, `GET /ais/routes/:mmsi1/:mmsi2?startTime&endTime`                             | `GET /ais/latest` (default since 24 h), `GET /ais/vessels/:mmsi/latest` + `/track`, `GET /ais/pairs/track?mmsi1&mmsi2&from&to`                                                                  |
| EWS (`checkShipStatus`), CII and transhipment triggered inside the AIS handler                                     | moved to the safety, emission and surveillance services, fed by `ais.position.recorded.v1`                                                                                                      |

## Methodology & references

Methods of the catalog (`docs/references/methods.json`, shipped as
`@darmawanweb/ais-its-contracts/references`) implemented here — also served by
`GET /api/v2/ais/methodology`. Implementing functions carry `@method <id>` TSDoc; thesis values
without an external source are marked `// SOURCE: thesis — needs citation`.

| Method id                                                                        | Where                                                                                            | Sources                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`data.ais_ingest_rules`](../../docs/METHODOLOGY.md#data.ais_ingest_rules)       | `normalize.ts` (`normalizeAisMessage`, `legacyPositionTime`), `movement.ts` (`classifyMovement`) | [ITU-R M.1371-5](https://www.itu.int/rec/R-REC-M.1371-5-201402-I), [AIVDM/AIVDO (gpsd)](https://gpsd.gitlab.io/gpsd/AIVDM.html), spec §13.2/§15.1, legacy `ais.service.ts`; thresholds need citation                            |
| [`navstatus.ais_codes`](../../docs/METHODOLOGY.md#navstatus.ais_codes)           | `normalize.ts` (navstatus 0..15, HDG 511, SOG 102.3, COG 360)                                    | [ITU-R M.1371-5](https://www.itu.int/rec/R-REC-M.1371-5-201402-I), [IMO A.1106(29)](<https://wwwcdn.imo.org/localresources/en/OurWork/Safety/Documents/AIS/Resolution%20A.1106(29).pdf>)                                        |
| [`navstatus.prediction`](../../docs/METHODOLOGY.md#navstatus.prediction)         | `navstatus.ts` (`calculatePredictedNavStatus`, `predictNavStatus`)                               | legacy `predict-navstatus.service.ts`; context: [Harati-Mokhtari et al. 2007](https://doi.org/10.1017/S0373463307004298), [Pallotta et al. 2013 (TREAD)](https://doi.org/10.3390/e15062218); 0.4 kn / 10° / 210 m need citation |
| [`geo.coast_distance`](../../docs/METHODOLOGY.md#geo.coast_distance)             | `coastline.ts` (`CoastlineGeometry.distanceM`)                                                   | [turf 7.2.0](https://github.com/Turfjs/turf/tree/v7.2.0) `nearestPointOnLine` + `distance` (R = 6 371 008.8 m), [flatbush](https://github.com/mourner/flatbush), legacy `calculate-ews.ts`                                      |
| [`data.indonesia_coastline`](../../docs/METHODOLOGY.md#data.indonesia_coastline) | `data/coastline.geojson`, `CoastlineGeometry.fromGeoJson`                                        | legacy `data/indonesia.json` (simplified Jawa Timur province polygon, mapshaper export); origin and licence need citation                                                                                                       |
| [`geo.haversine_distance`](../../docs/METHODOLOGY.md#geo.haversine_distance)     | duplicate filter (contracts `legacyHaversineDistance`, R = 3438 nm)                              | [Sinnott 1984 (via Movable Type)](https://movable-type.co.uk/scripts/latlong.html), legacy `speed-calculation.ts`                                                                                                               |
| `geo.track_simplification` (**proposed id**, not yet in the catalog)             | `simplify.ts` (`simplifyTrack`, `GET …/track?simplify=`)                                         | [Douglas & Peucker 1973](https://doi.org/10.3138/FM57-6770-U75U-7727), [Ramer 1972](<https://doi.org/10.1016/S0146-664X(72)80017-0>)                                                                                            |

The meaning of the provider's `utc` field is unconfirmed (it may be the ITU-R M.1371 time stamp,
the UTC second of the report); `timestamp − utc` is kept for parity, see
[`data.ais_ingest_rules`](../../docs/METHODOLOGY.md#data.ais_ingest_rules).

## Repository

[CHANGELOG](CHANGELOG.md) (Keep a Changelog, starts at 0.1.0) · conventional commits (commitlint,
Husky) · CI: format, lint, typecheck, unit + integration tests, build, OpenAPI freshness, image
(push on `main`) · release: tag `v<package.json version>` → versioned image.
