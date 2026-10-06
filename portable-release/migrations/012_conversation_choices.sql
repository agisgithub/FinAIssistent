CREATE TABLE conversation_choices (
  nonce TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('transaction','category')),
  payload_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
