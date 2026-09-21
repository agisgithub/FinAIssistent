CREATE TABLE financial_memories (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL,
  user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('planned_purchase','classification_hint','financial_note')),
  status TEXT NOT NULL CHECK(status IN ('active','expired','cancelled')),
  subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 200),
  note TEXT CHECK(note IS NULL OR length(note) BETWEEN 1 AND 600),
  merchant_pattern TEXT CHECK(merchant_pattern IS NULL OR length(merchant_pattern) BETWEEN 1 AND 160),
  category_name TEXT CHECK(category_name IS NULL OR length(category_name) BETWEEN 1 AND 160),
  expected_amount_cents INTEGER CHECK(expected_amount_cents IS NULL OR expected_amount_cents BETWEEN 1 AND 1000000000000),
  planned_on TEXT, expires_on TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, cancelled_at INTEGER,
  CHECK(kind<>'classification_hint' OR (merchant_pattern IS NOT NULL AND category_name IS NOT NULL))
);
CREATE INDEX financial_memories_context ON financial_memories(
  household_id,budget_id,user_id,chat_id,status,expires_on,created_at
);

CREATE TABLE financial_goals (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL,
  user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  title_key TEXT NOT NULL CHECK(length(title_key) BETWEEN 1 AND 200),
  metric TEXT NOT NULL CHECK(metric IN ('manual_savings_progress','category_spending_cap','account_balance')),
  status TEXT NOT NULL CHECK(status IN ('active','paused','completed','cancelled')),
  target_cents INTEGER NOT NULL CHECK(target_cents BETWEEN 1 AND 1000000000000),
  current_cents INTEGER CHECK(current_cents IS NULL OR current_cents BETWEEN 0 AND 1000000000000),
  category_name TEXT CHECK(category_name IS NULL OR length(category_name) BETWEEN 1 AND 160),
  account_name TEXT CHECK(account_name IS NULL OR length(account_name) BETWEEN 1 AND 160),
  target_on TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER,
  CHECK(
    (metric='manual_savings_progress' AND current_cents IS NOT NULL AND category_name IS NULL AND account_name IS NULL) OR
    (metric='category_spending_cap' AND current_cents IS NULL AND category_name IS NOT NULL AND account_name IS NULL) OR
    (metric='account_balance' AND current_cents IS NULL AND category_name IS NULL AND account_name IS NOT NULL)
  )
);
CREATE UNIQUE INDEX financial_goals_live_title ON financial_goals(
  household_id,budget_id,user_id,chat_id,title_key
) WHERE status IN ('active','paused');
CREATE INDEX financial_goals_context ON financial_goals(
  household_id,budget_id,user_id,chat_id,status,created_at
);

CREATE TABLE companion_mutations (
  source_job_id TEXT NOT NULL REFERENCES jobs(id), operation_key TEXT NOT NULL CHECK(length(operation_key) BETWEEN 1 AND 170),
  household_id TEXT NOT NULL REFERENCES households(id), budget_id TEXT NOT NULL,
  user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('record_memory','cancel_memory','create_goal','set_goal_progress','add_goal_progress','pause_goal','resume_goal','complete_goal','cancel_goal')),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64), result_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(source_job_id,operation_key)
);
CREATE INDEX companion_mutations_scope ON companion_mutations(
  household_id,budget_id,user_id,chat_id,created_at
);
