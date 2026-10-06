CREATE TABLE conversation_sessions (
  household_id TEXT NOT NULL, budget_id TEXT NOT NULL, user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1, provider TEXT NOT NULL DEFAULT 'ollama' CHECK(provider IN ('ollama','gemini')),
  model TEXT, updated_at INTEGER NOT NULL, truncated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(household_id,budget_id,user_id,chat_id)
);
CREATE TABLE conversation_turns (
  id TEXT PRIMARY KEY, source_job_id TEXT UNIQUE REFERENCES jobs(id), household_id TEXT NOT NULL,
  budget_id TEXT NOT NULL, user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','completed')), created_at INTEGER NOT NULL,
  user_text TEXT, assistant_text TEXT, selection_json TEXT, response_json TEXT, provider TEXT, model TEXT
);
CREATE INDEX conversation_recent ON conversation_turns(household_id,budget_id,user_id,chat_id,generation,created_at);
CREATE TABLE conversation_consents (
  nonce TEXT PRIMARY KEY, household_id TEXT NOT NULL, budget_id TEXT NOT NULL, user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL, generation INTEGER NOT NULL, context_hash TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('persistent','once')), question TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);
