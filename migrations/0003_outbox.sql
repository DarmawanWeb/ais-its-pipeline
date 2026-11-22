-- 0003_outbox — transactional outbox of ais.position.recorded.v1 (spec §7.1, §13.2).
--
-- The processor enqueues the event of every recorded position in the
-- transaction that writes its rows (positions, vessel_latest): an event can
-- neither be lost after the rows committed nor be published for rows that
-- rolled back. The kit's OutboxRelay publishes the rows to AIS_POSITION in
-- insertion order with the row id (deterministic per position) as envelope
-- id and Nats-Msg-Id, and deletes them 10 minutes after publication (the
-- events themselves stay in AIS_POSITION for 7 days). The DDL is
-- outboxTableSql() of @darmawanweb/ais-its-nest 0.2.0; runs in one
-- transaction.

CREATE TABLE IF NOT EXISTS "outbox" (
  id uuid PRIMARY KEY,
  type text NOT NULL,
  entity_key text,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  published_at timestamptz,
  failed_at timestamptz
);
CREATE INDEX IF NOT EXISTS "outbox_pending_idx" ON "outbox" (created_at, id)
  WHERE published_at IS NULL AND failed_at IS NULL;

-- A queue table: every row is inserted, updated once (published_at) and
-- deleted within minutes. Vacuum it early so the partial index of pending
-- rows the relay scans does not bloat.
ALTER TABLE outbox SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

COMMENT ON TABLE outbox IS
  'Transactional outbox of ais.position.recorded.v1 (kit OutboxRelay; published rows kept 10 minutes)';
