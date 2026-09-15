CREATE TABLE assistant_action_proposals (
  id TEXT PRIMARY KEY, nonce TEXT NOT NULL UNIQUE,
  source_job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL,
  user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','approved','cancelled','expired')),
  input_hash TEXT NOT NULL, policy_hash TEXT NOT NULL, plan_json TEXT,
  dry_run INTEGER NOT NULL CHECK(dry_run IN (0,1)), created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE TABLE assistant_action_operations (
  id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE REFERENCES assistant_action_proposals(id),
  confirmation_job_id TEXT NOT NULL REFERENCES jobs(id), household_id TEXT NOT NULL, budget_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','executing','applied','failed_before','partial','uncertain','simulated')),
  result_json TEXT, state_backup_ref TEXT, error_code TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE assistant_action_events (
  id TEXT PRIMARY KEY, operation_id TEXT REFERENCES assistant_action_operations(id),
  household_id TEXT NOT NULL, event TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX assistant_action_proposals_retention ON assistant_action_proposals(state,created_at);
CREATE INDEX assistant_action_operations_state ON assistant_action_operations(state,updated_at);
CREATE TABLE assistant_action_targets (
  operation_id TEXT NOT NULL REFERENCES assistant_action_operations(id), target_id TEXT NOT NULL,
  state TEXT NOT NULL, PRIMARY KEY(operation_id,target_id)
);
CREATE TABLE operation_target_order (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, household_id TEXT NOT NULL, budget_id TEXT NOT NULL,
  target_id TEXT NOT NULL, operation_id TEXT NOT NULL, operation_kind TEXT NOT NULL CHECK(operation_kind IN ('category','assistant'))
);
CREATE INDEX operation_target_order_target ON operation_target_order(household_id,budget_id,target_id,sequence);
