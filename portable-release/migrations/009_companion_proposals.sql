CREATE TABLE companion_proposals (
  id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL UNIQUE CHECK(length(nonce)=24),
  source_job_id TEXT NOT NULL REFERENCES jobs(id),
  operation_key TEXT NOT NULL CHECK(length(operation_key) BETWEEN 1 AND 170),
  household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL,
  user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('record_memory','manage_goal')),
  state TEXT NOT NULL CHECK(state IN ('pending','confirmed','cancelled','expired')),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64),
  policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64),
  plan_json TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER,
  confirmation_job_id TEXT REFERENCES jobs(id), result_json TEXT,
  UNIQUE(source_job_id,operation_key)
);
CREATE INDEX companion_proposals_scope ON companion_proposals(
  household_id,budget_id,user_id,chat_id,state,created_at
);
