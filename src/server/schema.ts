/**
 * Canonical database schema for the Command Center.
 *
 * This string is the runtime source of truth: the Postgres store applies it
 * (idempotently, CREATE TABLE IF NOT EXISTS) the first time it runs with a
 * DATABASE_URL. migrations/0001_init.sql mirrors it for humans and external
 * tooling; if you change one, change the other.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  description   TEXT NOT NULL,
  capability    TEXT NOT NULL,
  capabilities  JSONB NOT NULL DEFAULT '[]'::jsonb,
  handles_intents JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- For databases created before the enable/disable control existed.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  command     TEXT NOT NULL,
  intent      TEXT,
  router      TEXT,
  status      TEXT NOT NULL DEFAULT 'queued',
  agent_id    TEXT,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'working',
  tool_calls   JSONB NOT NULL DEFAULT '[]'::jsonb,
  error        TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  task_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS results (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id      TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saved_items (
  id         TEXT PRIMARY KEY,
  result_id  TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_task ON agent_runs (task_id);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON agent_runs (agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_task ON results (task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_results ON saved_items (result_id);
CREATE INDEX IF NOT EXISTS idx_saved_created ON saved_items (created_at DESC);
`;
