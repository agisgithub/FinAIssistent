ALTER TABLE operations ADD COLUMN origin TEXT NOT NULL DEFAULT 'telegram_confirmation'
  CHECK(origin IN ('telegram_confirmation','companion_high_confidence'));
ALTER TABLE operations ADD COLUMN feature_key TEXT;
ALTER TABLE operations ADD COLUMN decision_json TEXT;
CREATE UNIQUE INDEX operations_confirmation_job_unique ON operations(confirmation_job_id)
  WHERE confirmation_job_id IS NOT NULL;

CREATE TABLE transaction_monitor_state (
  household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL,
  initialized_at INTEGER NOT NULL, last_success_at INTEGER NOT NULL,
  last_slot INTEGER NOT NULL, last_snapshot_id TEXT, last_synced_at TEXT,
  PRIMARY KEY(household_id,budget_id)
);

CREATE TABLE transaction_monitor_runs (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL,
  slot INTEGER NOT NULL, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  state TEXT NOT NULL CHECK(state IN ('pending','completed','unavailable')),
  baseline INTEGER NOT NULL DEFAULT 0 CHECK(baseline IN (0,1)),
  created_at INTEGER NOT NULL, completed_at INTEGER,
  snapshot_id TEXT, synced_at TEXT, error_code TEXT,
  UNIQUE(household_id,budget_id,slot)
);

CREATE TABLE transaction_observations (
  household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL,
  user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
  transaction_id TEXT NOT NULL,
  first_fingerprint TEXT NOT NULL CHECK(length(first_fingerprint)=64),
  latest_fingerprint TEXT NOT NULL CHECK(length(latest_fingerprint)=64),
  state TEXT NOT NULL CHECK(state IN (
    'baseline','ignored','pending','auto_queued','question_queued','questioned',
    'applied','failed_before','uncertain','resolved_external'
  )),
  decision_json TEXT, job_id TEXT REFERENCES jobs(id), operation_id TEXT REFERENCES operations(id),
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  PRIMARY KEY(household_id,budget_id,transaction_id)
);
CREATE INDEX transaction_observations_pending ON transaction_observations(
  household_id,budget_id,state,first_seen_at
);

CREATE TABLE transaction_monitor_deliveries (
  outbox_id TEXT PRIMARY KEY REFERENCES outbox(id),
  household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL, fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1))
);
