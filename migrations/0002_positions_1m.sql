-- aisits:no-transaction
-- 0002_positions_1m — one-minute track aggregate (spec §13.2): last position
-- of each vessel per minute, mean and maximum SOG and the number of reports.
-- Continuous aggregates cannot be created inside a transaction block, hence
-- the marker above (statements run one by one). Real-time aggregation
-- (materialized_only = false) serves the minutes not materialized yet.

CREATE MATERIALIZED VIEW positions_1m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 minute', time) AS bucket,
  mmsi,
  last(geom, time)           AS geom,
  last(sog, time)            AS sog,
  avg(sog)                   AS sog_avg,
  max(sog)                   AS sog_max,
  last(cog, time)            AS cog,
  last(hdg, time)            AS hdg,
  last(navstatus, time)      AS navstatus,
  last(pred_navstatus, time) AS pred_navstatus,
  last(source, time)         AS source,
  count(*)                   AS samples,
  max(time)                  AS last_time
FROM positions
GROUP BY bucket, mmsi
WITH NO DATA;

COMMENT ON MATERIALIZED VIEW positions_1m IS
  'One-minute track aggregate of positions (refreshed every minute over the last 2 days, kept 5 years)';

-- Re-materializes the last two days every minute (late reports included);
-- older raw chunks are compressed (3 d) and dropped (180 d) independently.
SELECT add_continuous_aggregate_policy('positions_1m',
  start_offset => INTERVAL '2 days',
  end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');

ALTER MATERIALIZED VIEW positions_1m SET (timescaledb.compress = true);
SELECT add_compression_policy('positions_1m', compress_after => INTERVAL '7 days');
SELECT add_retention_policy('positions_1m', drop_after => INTERVAL '5 years');
