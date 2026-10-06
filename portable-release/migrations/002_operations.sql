CREATE TABLE proposals (
  id TEXT PRIMARY KEY, nonce TEXT NOT NULL UNIQUE, source_job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL, user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('category','undo')), state TEXT NOT NULL CHECK(state IN ('pending','approved','cancelled','expired')),
  target_id TEXT, before_fingerprint TEXT NOT NULL, after_fingerprint TEXT NOT NULL,
  before_json TEXT, after_json TEXT, display_json TEXT, reason_json TEXT, expected_category_json TEXT, feature_key TEXT,
  policy_version TEXT NOT NULL, policy_hash TEXT NOT NULL, dry_run INTEGER NOT NULL CHECK(dry_run IN (0,1)),
  undo_of TEXT REFERENCES operations(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE INDEX proposals_retention ON proposals(state, created_at);
ALTER TABLE operations ADD COLUMN proposal_id TEXT REFERENCES proposals(id);
ALTER TABLE operations ADD COLUMN confirmation_job_id TEXT REFERENCES jobs(id);
ALTER TABLE operations ADD COLUMN policy_hash TEXT;
ALTER TABLE operations ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 1;
ALTER TABLE operations ADD COLUMN undo_of TEXT REFERENCES operations(id);
ALTER TABLE operations ADD COLUMN state_backup_ref TEXT;
ALTER TABLE operations ADD COLUMN actual_backup_ref TEXT;
ALTER TABLE operations ADD COLUMN initial_outcome TEXT;
CREATE UNIQUE INDEX operations_proposal ON operations(proposal_id) WHERE proposal_id IS NOT NULL;
ALTER TABLE operation_items ADD COLUMN before_fingerprint TEXT;
ALTER TABLE operation_items ADD COLUMN after_fingerprint TEXT;
ALTER TABLE operation_items ADD COLUMN observed_fingerprint TEXT;
ALTER TABLE operation_items ADD COLUMN observed_at INTEGER;
ALTER TABLE operation_items ADD COLUMN reconciliation TEXT;
CREATE TABLE category_examples (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id), household_id TEXT NOT NULL, budget_id TEXT NOT NULL,
  target_id TEXT, feature_key TEXT, category_id TEXT, active INTEGER NOT NULL CHECK(active IN (0,1)), created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX category_examples_active_target ON category_examples(household_id,budget_id,target_id) WHERE active=1;
CREATE INDEX category_examples_feature ON category_examples(household_id,budget_id,feature_key,active);
