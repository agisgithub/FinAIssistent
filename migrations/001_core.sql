CREATE TABLE households (id TEXT PRIMARY KEY, timezone TEXT NOT NULL, currency TEXT NOT NULL);
CREATE TABLE users (household_id TEXT NOT NULL REFERENCES households(id), user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, PRIMARY KEY(household_id, user_id));
CREATE TABLE budget_bindings (household_id TEXT PRIMARY KEY REFERENCES households(id), budget_id TEXT NOT NULL);
CREATE TABLE preferences (household_id TEXT NOT NULL REFERENCES households(id), key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(household_id, key));
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE telegram_updates (epoch INTEGER NOT NULL, update_id INTEGER NOT NULL, received_at INTEGER NOT NULL, authorized INTEGER NOT NULL CHECK(authorized IN (0,1)), PRIMARY KEY(epoch,update_id));
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL, payload TEXT, safe_retry INTEGER NOT NULL CHECK(safe_retry IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('queued','running','done','failed','uncertain')),
  priority INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error_code TEXT
);
CREATE INDEX jobs_pending ON jobs(state, priority DESC, available_at);
CREATE TABLE job_attempts (job_id TEXT NOT NULL REFERENCES jobs(id), attempt INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT, PRIMARY KEY(job_id,attempt));
CREATE TABLE outbox (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), chat_id INTEGER NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE, payload TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','failed','uncertain')),
  attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, message_id INTEGER, error_code TEXT
);
CREATE INDEX outbox_pending ON outbox(state, available_at);
CREATE TABLE snapshots (id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE operations (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL,
  kind TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error_code TEXT
);
CREATE TABLE operation_items (operation_id TEXT NOT NULL REFERENCES operations(id), target_id TEXT NOT NULL, before_json TEXT, after_json TEXT, state TEXT NOT NULL, PRIMARY KEY(operation_id,target_id));
CREATE TABLE audit_events (id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), operation_id TEXT REFERENCES operations(id), event TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL);
