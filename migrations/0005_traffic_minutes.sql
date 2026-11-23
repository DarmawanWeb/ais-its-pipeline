-- 0005_traffic_minutes — history of GET /ais/stats (spec §13.2): the traffic
-- counters of every minute, per feed, for GET /ais/stats/series.
--
-- Every processor replica runs a sampler that, a few seconds after each
-- minute ends, inserts that minute's row per feed (ON CONFLICT DO NOTHING:
-- the first replica wins, a sampled minute is never rewritten):
--   messages       — positions recorded with a position time in the minute
--                    (as `messagesLastMinute` at the end of the minute);
--   active_vessels — vessels whose latest position, from this feed, is at
--                    most 10 minutes older than the end of the minute (as
--                    `activeVessels`).
-- "Active vessels" cannot be recomputed later (vessel_latest moves on), so
-- the history starts with the first processor of this version; a minute in
-- which no processor ran has no rows (a gap in the series).
--
-- One row per minute and feed (≈ 1.6 million rows a year): a hypertable
-- with 7-day chunks, kept one year. Runs in one transaction.

CREATE TABLE IF NOT EXISTS traffic_minutes (
  minute         timestamptz NOT NULL,
  source         text NOT NULL CHECK (source IN ('primary', 'batam', 'pusher')),
  messages       integer NOT NULL CHECK (messages >= 0),
  active_vessels integer NOT NULL CHECK (active_vessels >= 0),
  sampled_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (minute, source)
);

-- The primary key serves the range scans by minute: no default time index.
SELECT create_hypertable('traffic_minutes', by_range('minute', INTERVAL '7 days'),
  create_default_indexes => false, if_not_exists => true);
SELECT add_retention_policy('traffic_minutes', INTERVAL '1 year', if_not_exists => true);

COMMENT ON TABLE traffic_minutes IS
  'Traffic counters per minute and feed (GET /ais/stats history, written by the processor sampler, kept 1 year)';
COMMENT ON COLUMN traffic_minutes.minute IS
  'Start of the sampled minute (UTC)';
COMMENT ON COLUMN traffic_minutes.messages IS
  'Positions recorded with a position time in the minute (by the time it was sampled)';
COMMENT ON COLUMN traffic_minutes.active_vessels IS
  'Vessels whose latest position came from this feed within 10 minutes before the end of the minute';
