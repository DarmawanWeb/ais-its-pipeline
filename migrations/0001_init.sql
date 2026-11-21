-- 0001_init — schema "ais" of ais-its-pipeline (docs/PLATFORM_SPEC.md §6, §13.2).
--
-- Runs inside schema "ais" (search_path=ais,public) as the role ais_svc, in
-- one transaction. The infrastructure creates the extensions (timescaledb,
-- postgis, pgcrypto) in "public"; services never CREATE EXTENSION.
-- Forward-only: never edit an applied file (its checksum is verified at
-- startup) — add 0003_<change>.sql instead.

COMMENT ON SCHEMA ais IS 'ais-pipeline (ais-processor) — owned by ais_svc';

-- Every recorded AIS position (immutable; out-of-order reports included).
CREATE TABLE positions (
  time           timestamptz NOT NULL,
  mmsi           integer NOT NULL CHECK (mmsi BETWEEN 100000000 AND 999999999),
  source         text NOT NULL CHECK (source IN ('primary', 'batam', 'pusher')),
  geom           geography(Point, 4326) NOT NULL,
  sog            double precision NOT NULL,
  cog            double precision NOT NULL,
  hdg            double precision NOT NULL,
  navstatus      smallint NOT NULL CHECK (navstatus BETWEEN 0 AND 15),
  pred_navstatus smallint NOT NULL CHECK (pred_navstatus IN (0, 1)),
  coast_dist_m   double precision CHECK (coast_dist_m >= 0),
  PRIMARY KEY (mmsi, time)
);

COMMENT ON TABLE positions IS
  'Recorded AIS positions (hypertable, 1-day chunks, compressed after 3 days, kept 180 days)';
COMMENT ON COLUMN positions.pred_navstatus IS
  '1 = predicted at anchor (legacy calculatePredictedNavStatus, method navstatus.prediction)';
COMMENT ON COLUMN positions.coast_dist_m IS
  'Distance to the coast polygon in metres (method geo.coast_distance); NULL without coast geometry';

SELECT create_hypertable('positions', by_range('time', INTERVAL '1 day'));

ALTER TABLE positions SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'mmsi',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('positions', INTERVAL '3 days');
SELECT add_retention_policy('positions', INTERVAL '180 days');

-- Latest position per vessel (maintained by the processor; map initial state).
CREATE TABLE vessel_latest (
  mmsi           integer PRIMARY KEY CHECK (mmsi BETWEEN 100000000 AND 999999999),
  time           timestamptz NOT NULL,
  source         text NOT NULL CHECK (source IN ('primary', 'batam', 'pusher')),
  lat            double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon            double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geom           geography(Point, 4326) NOT NULL,
  sog            double precision NOT NULL,
  cog            double precision NOT NULL,
  hdg            double precision NOT NULL,
  navstatus      smallint NOT NULL CHECK (navstatus BETWEEN 0 AND 15),
  pred_navstatus smallint NOT NULL CHECK (pred_navstatus IN (0, 1)),
  coast_dist_m   double precision CHECK (coast_dist_m >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE vessel_latest IS
  'Latest recorded position per vessel; never replaced by an older (out-of-order) report';

-- bbox queries compare in lon/lat geometry space (kit geographyIntersectsBBox).
CREATE INDEX vessel_latest_geom_idx ON vessel_latest USING gist ((geom::geometry));
CREATE INDEX vessel_latest_time_idx ON vessel_latest (time DESC);

-- Projection of the FLEET stream (consumer ais-processor-fleet): vessel
-- identity to enrich responses (shared across tenants, spec §8.5).
CREATE TABLE vessel_refs (
  mmsi       integer PRIMARY KEY CHECK (mmsi BETWEEN 100000000 AND 999999999),
  vessel_id  uuid NOT NULL,
  name       text NOT NULL,
  type_code  text,
  updated_at timestamptz NOT NULL,
  CONSTRAINT vessel_refs_vessel_id_key UNIQUE (vessel_id)
);

COMMENT ON TABLE vessel_refs IS
  'FLEET projection: mmsi -> vessel id, name, type code (updated_at = snapshot updatedAt)';
