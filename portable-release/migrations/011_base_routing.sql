CREATE TABLE base_route_selections (
  household_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  active_alias TEXT NOT NULL,
  profile_policy_hash TEXT NOT NULL CHECK(length(profile_policy_hash)=64),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(household_id,user_id,chat_id)
);

CREATE TABLE telegram_route_ledger (
  epoch INTEGER NOT NULL,
  update_id INTEGER NOT NULL,
  household_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  profile_alias TEXT NOT NULL,
  profile_policy_hash TEXT NOT NULL CHECK(length(profile_policy_hash)=64),
  state TEXT NOT NULL CHECK(state IN ('pending','forwarded','rejected')),
  payload_json TEXT,
  target_dedupe_key TEXT NOT NULL,
  target_job_id TEXT,
  rejection_code TEXT CHECK(rejection_code IS NULL OR rejection_code IN ('profile_policy_changed','profile_removed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  forwarded_at INTEGER,
  PRIMARY KEY(epoch,update_id),
  FOREIGN KEY(epoch,update_id) REFERENCES telegram_updates(epoch,update_id)
);

CREATE INDEX telegram_route_pending ON telegram_route_ledger(state,created_at,epoch,update_id);
