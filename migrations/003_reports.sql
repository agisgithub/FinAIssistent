CREATE TABLE report_occurrences (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('daily','alerts')), slot_key TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL, report_date TEXT NOT NULL, policy_revision INTEGER NOT NULL,
  job_id TEXT UNIQUE REFERENCES jobs(id), state TEXT NOT NULL CHECK(state IN ('pending','completed','unavailable','cancelled')),
  created_at INTEGER NOT NULL, completed_at INTEGER, snapshot_id TEXT, data_state TEXT,
  UNIQUE(household_id,budget_id,kind,slot_key)
);
CREATE TABLE report_deliveries (
  outbox_id TEXT PRIMARY KEY REFERENCES outbox(id), occurrence_id TEXT NOT NULL REFERENCES report_occurrences(id),
  kind TEXT NOT NULL CHECK(kind IN ('daily','alerts')), policy_revision INTEGER NOT NULL, scope_json TEXT NOT NULL,
  alert_state_key TEXT, alert_transition_index INTEGER,
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1))
);
CREATE TABLE alert_state (
  state_key TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL,
  rule_version TEXT NOT NULL, type TEXT NOT NULL, target_id TEXT NOT NULL, competence TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('none','warning','critical')),
  episode INTEGER NOT NULL DEFAULT 0, transition_index INTEGER NOT NULL DEFAULT 0,
  last_observed_at INTEGER NOT NULL, snapshot_id TEXT NOT NULL
);
CREATE TABLE alert_transitions (
  id TEXT PRIMARY KEY, state_key TEXT NOT NULL REFERENCES alert_state(state_key),
  occurrence_id TEXT NOT NULL REFERENCES report_occurrences(id), episode INTEGER NOT NULL,
  transition_index INTEGER NOT NULL, before_severity TEXT NOT NULL, after_severity TEXT NOT NULL,
  created_at INTEGER NOT NULL, snapshot_id TEXT NOT NULL,
  UNIQUE(state_key,transition_index)
);
