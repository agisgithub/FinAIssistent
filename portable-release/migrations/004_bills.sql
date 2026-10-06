CREATE TABLE bill_units (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL,
  name TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE recurring_bills (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL,
  unit_id TEXT NOT NULL REFERENCES bill_units(id), revision INTEGER NOT NULL, active INTEGER NOT NULL,
  payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE bill_versions (
  bill_id TEXT NOT NULL REFERENCES recurring_bills(id), revision INTEGER NOT NULL,
  effective_from TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(bill_id,revision)
);
CREATE TABLE bill_assignments (
  household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL, transaction_id TEXT NOT NULL,
  unit_id TEXT NOT NULL REFERENCES bill_units(id), fingerprint TEXT NOT NULL, revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(household_id,budget_id,transaction_id)
);
CREATE TABLE recurrence_candidates (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','rejected','accepted')), payload TEXT,
  snapshot_id TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE bill_occurrences (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL,
  bill_id TEXT NOT NULL REFERENCES recurring_bills(id), competence TEXT NOT NULL,
  revision INTEGER NOT NULL, local_state TEXT NOT NULL CHECK(local_state IN ('open','paid_manual','cancelled')),
  payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(household_id,budget_id,bill_id,competence)
);
CREATE TABLE bill_matches (
  occurrence_id TEXT PRIMARY KEY REFERENCES bill_occurrences(id), payload TEXT NOT NULL,
  snapshot_id TEXT NOT NULL, observed_at INTEGER NOT NULL
);
CREATE TABLE bill_proposals (
  id TEXT PRIMARY KEY, nonce TEXT UNIQUE NOT NULL, source_job_id TEXT UNIQUE NOT NULL REFERENCES jobs(id),
  household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL, user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
  kind TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','confirmed','cancelled')),
  policy_hash TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  consumed_at INTEGER, confirmation_job_id TEXT REFERENCES jobs(id), result_json TEXT
);
CREATE TABLE bill_events (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL,
  kind TEXT NOT NULL, entity_id TEXT NOT NULL, dedupe_key TEXT UNIQUE NOT NULL,
  payload TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE bill_deliveries (
  outbox_id TEXT PRIMARY KEY REFERENCES outbox(id), event_id TEXT NOT NULL REFERENCES bill_events(id),
  bill_id TEXT NOT NULL REFERENCES recurring_bills(id), occurrence_id TEXT NOT NULL REFERENCES bill_occurrences(id),
  kind TEXT NOT NULL CHECK(kind IN ('reminder','overdue','variation')),
  occurrence_revision INTEGER NOT NULL, policy_revision INTEGER NOT NULL, match_fingerprint TEXT,
  scheduled_at INTEGER NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX bill_occurrence_lookup ON bill_occurrences(bill_id,competence);
CREATE INDEX bill_delivery_lookup ON bill_deliveries(occurrence_id,cancelled);
CREATE TABLE bill_variation_state (
  occurrence_id TEXT PRIMARY KEY REFERENCES bill_occurrences(id), active INTEGER NOT NULL,
  episode INTEGER NOT NULL, observed_key TEXT NOT NULL, policy_revision INTEGER NOT NULL,
  direction TEXT NOT NULL DEFAULT 'unchanged'
);
