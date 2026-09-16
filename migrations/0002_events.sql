-- Migration 0002: orchestration events (live activity stream).
-- Mirrors the events table in src/server/schema.ts (runtime source of truth,
-- applied idempotently via CREATE TABLE IF NOT EXISTS). Applied here for
-- humans and external tooling; safe to run on an existing database.
CREATE TABLE IF NOT EXISTS events (
  seq       BIGSERIAL PRIMARY KEY,
  id        TEXT NOT NULL,
  type      TEXT NOT NULL,
  task_id   TEXT,
  run_id    TEXT,
  agent_id  TEXT,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  data      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_events_task ON events (task_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_seq ON events (seq);
