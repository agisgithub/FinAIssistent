import Database from 'better-sqlite3';
import { readFileSync, readdirSync, mkdirSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, ERROR_CODES } from '../errors.mjs';
import { badConfig } from '../config-diagnostics.mjs';
import { recoverOperations, pruneOperations } from '../audit/operations.mjs';
import { withActionMetadata } from '../categorization/response.mjs';
import { recoverAssistantActions, pruneAssistantActions } from '../application/assistant-actions.mjs';
import { pruneConversations } from '../conversation/store.mjs';

const migrationsPath = fileURLToPath(new URL('../../migrations/', import.meta.url));
const decode = row => row ? { ...row, payload: row.payload == null ? null : JSON.parse(row.payload) } : null;
const serialized = (value, max = 32768) => {
  const json = JSON.stringify(value);
  if (typeof json !== 'string' || Buffer.byteLength(json) > max) throw new AppError('INPUT_INVALID');
  return json;
};
const keyValid = key => typeof key === 'string' && key.length > 0 && key.length <= 256;
const safeCode = code => ERROR_CODES.has(code) ? code : 'INTERNAL_ERROR';
// Telegram retains updates for <=24h and randomizes IDs after >=7 idle days.
// Reset after 48h to avoid expiry/long-poll boundary races without replaying
// retained messages. A fresh epoch keeps historical local dedupe separate.
const TELEGRAM_IDLE_RESET_MS = 48 * 60 * 60 * 1000;
export function splitMessage(text) {
  if (typeof text !== 'string' || !text || text.length > 100000) throw new AppError('INPUT_INVALID');
  const chunks = [];
  while (text.length > 3900) {
    let end = text.lastIndexOf('\n', 3900);
    if (end < 1950) end = 3900;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) chunks.push(text);
  return chunks;
}

export class StateStore {
  constructor(filename, identity, { now = Date.now, conversationConfig = {} } = {}) {
    this.identity = Object.freeze({ ...identity });
    this.now = now;
    this.conversationConfig = conversationConfig;
    if (filename !== ':memory:') {
      mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') chmodSync(path.dirname(filename), 0o700);
    }
    this.db = new Database(filename);
    try {
    if (filename !== ':memory:' && process.platform !== 'win32') chmodSync(filename, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = FULL');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const name of readdirSync(migrationsPath).filter(x => /^\d+_.*\.sql$/.test(x)).sort()) {
      this.db.transaction(() => {
        if (this.db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(name)) return;
        this.db.exec(readFileSync(path.join(migrationsPath, name), 'utf8'));
        this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(name, this.now());
      })();
    }
    this.db.transaction(() => {
      const { householdId, budgetId, userId, chatId, timezone = 'America/Sao_Paulo', currency = 'BRL' } = identity;
      const binding = this.db.prepare('SELECT budget_id FROM budget_bindings WHERE household_id=?').get(householdId);
      const other = this.db.prepare('SELECT id FROM households WHERE id<>? LIMIT 1').get(householdId);
      const owner = this.db.prepare('SELECT user_id,chat_id FROM users WHERE household_id=?').get(householdId);
      if (other || (binding && binding.budget_id !== budgetId) || (owner && (owner.user_id !== userId || owner.chat_id !== chatId))) badConfig('state', 'state_identity_mismatch');
      this.db.prepare('INSERT OR IGNORE INTO households VALUES (?,?,?)').run(householdId, timezone, currency);
      this.db.prepare('INSERT OR IGNORE INTO users VALUES (?,?,?)').run(householdId, userId, chatId);
      this.db.prepare('INSERT OR IGNORE INTO budget_bindings VALUES (?,?)').run(householdId, budgetId);
    })();
    } catch (error) { this.db.close(); throw error instanceof AppError ? error : new AppError('STORAGE_FAILED'); }
  }
  assertIdentity(identity) {
    for (const key of ['householdId', 'budgetId', 'userId', 'chatId']) if (identity[key] !== this.identity[key]) throw new AppError('UNAUTHORIZED');
  }
  close() { this.db.close(); }
  transaction(fn) { return this.db.transaction(fn)(); }
  splitMessage(text) { return splitMessage(text); }
  telegramEpochExpired() {
    const recorded = this.db.prepare("SELECT value FROM metadata WHERE key='telegram_last_received_at'").get()?.value;
    const last = recorded == null ? this.db.prepare('SELECT MAX(received_at) at FROM telegram_updates').get().at : Number(recorded);
    return last != null && this.now() - last >= TELEGRAM_IDLE_RESET_MS;
  }
  cursor() { return this.telegramEpochExpired() ? 0 : Number(this.db.prepare("SELECT value FROM metadata WHERE key='telegram_offset'").get()?.value ?? 0); }
  bindTelegramBot(botId) {
    if (!Number.isSafeInteger(botId) || botId <= 0) badConfig('telegram', 'invalid_bot_identity');
    this.transaction(() => {
      const old = this.db.prepare("SELECT value FROM metadata WHERE key='telegram_bot_id'").get()?.value;
      if (old && old !== String(botId)) badConfig('state', 'bot_identity_mismatch');
      this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('telegram_bot_id',?)").run(String(botId));
    });
  }
  acceptUpdate(updateId, request = null) {
    if (!Number.isSafeInteger(updateId) || updateId < 0 || updateId === Number.MAX_SAFE_INTEGER) throw new AppError('INPUT_INVALID');
    return this.transaction(() => {
      if (request) this.assertIdentity(request.identity);
      const expired = this.telegramEpochExpired();
      let epoch = Number(this.db.prepare("SELECT value FROM metadata WHERE key='telegram_epoch'").get()?.value ?? 0);
      if (expired) {
        epoch++;
        this.db.prepare("INSERT INTO metadata VALUES ('telegram_epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(epoch));
        this.db.prepare("INSERT INTO metadata VALUES ('telegram_offset','0') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
      }
      const inserted = this.db.prepare('INSERT OR IGNORE INTO telegram_updates VALUES (?,?,?,?)').run(epoch, updateId, this.now(), request ? 1 : 0).changes;
      this.db.prepare("INSERT INTO metadata VALUES ('telegram_last_received_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(this.now()));
      this.db.prepare("INSERT INTO metadata VALUES ('telegram_offset',?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)").run(String(updateId + 1));
      if (!inserted || !request) return null;
      return this.enqueueJob({ kind: 'command', payload: request, dedupeKey: `telegram:${epoch}:${updateId}`, safeRetry: true });
    });
  }
  enqueueJob({ kind, payload, dedupeKey, safeRetry = true, priority = 0, availableAt = this.now() }) {
    if (!keyValid(kind) || !keyValid(dedupeKey) || typeof safeRetry !== 'boolean' || !Number.isSafeInteger(priority) || !Number.isSafeInteger(availableAt)) throw new AppError('INPUT_INVALID');
    const id = randomUUID();
    const changes = this.db.prepare("INSERT OR IGNORE INTO jobs (id,household_id,dedupe_key,kind,payload,safe_retry,state,priority,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?,?)")
      .run(id, this.identity.householdId, dedupeKey, kind, serialized(payload), safeRetry ? 1 : 0, priority, availableAt, this.now(), this.now()).changes;
    return changes ? id : null;
  }
  claimJob() {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM jobs WHERE household_id=? AND state='queued' AND available_at<=? ORDER BY priority DESC,created_at,rowid LIMIT 1").get(this.identity.householdId, this.now());
      if (!row) return null;
      this.db.prepare("UPDATE jobs SET state='running',attempts=attempts+1,updated_at=? WHERE id=?").run(this.now(), row.id);
      this.db.prepare('INSERT INTO job_attempts(job_id,attempt,started_at) VALUES (?,?,?)').run(row.id, row.attempts + 1, this.now());
      return decode({ ...row, state: 'running', attempts: row.attempts + 1 });
    });
  }
  completeJob(jobId, message = null) {
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM jobs WHERE id=? AND household_id=? AND state='running'").get(jobId, this.identity.householdId);
      if (!row) throw new AppError('STORAGE_FAILED');
      if (message) {
        const chunks = splitMessage(message.text);
        for (let i = 0; i < chunks.length; i++) this.enqueueOutbox({ ...message, text: chunks[i], replyMarkup: i === chunks.length - 1 ? message.replyMarkup : undefined, dedupeKey: `${message.dedupeKey ?? `job:${jobId}`}:${i}` });
      }
      this.db.prepare("UPDATE jobs SET state='done',updated_at=? WHERE id=?").run(this.now(), jobId);
      this.db.prepare("UPDATE job_attempts SET finished_at=?,outcome='done' WHERE job_id=? AND attempt=?").run(this.now(), jobId, row.attempts);
    });
  }
  failJob(job, code) {
    code = safeCode(code);
    this.transaction(() => {
      const persisted = this.db.prepare('SELECT safe_retry FROM jobs WHERE id=? AND household_id=?').get(job.id, this.identity.householdId);
      if (!persisted) throw new AppError('STORAGE_FAILED');
      const state = persisted.safe_retry ? 'failed' : 'uncertain';
      this.db.prepare('UPDATE jobs SET state=?,error_code=?,updated_at=? WHERE id=? AND household_id=?').run(state, code, this.now(), job.id, this.identity.householdId);
      this.db.prepare('UPDATE job_attempts SET finished_at=?,outcome=? WHERE job_id=? AND attempt=?').run(this.now(), state, job.id, job.attempts);
      this.enqueueOutbox(withActionMetadata({ text: `Não foi possível concluir. Código: ${code}.`, dedupeKey: `job-error:${job.id}` }, { reason: 'command_error', failure: code }));
    });
  }
  enqueueOutbox({ text, dedupeKey, chatId = this.identity.chatId, replyMarkup = undefined }) {
    if (!keyValid(dedupeKey)) throw new AppError('INPUT_INVALID');
    if (chatId !== this.identity.chatId || typeof text !== 'string' || text.length < 1 || text.length > 4000) throw new AppError('UNAUTHORIZED');
    const id = randomUUID();
    const changes = this.db.prepare("INSERT OR IGNORE INTO outbox(id,household_id,chat_id,dedupe_key,payload,state,available_at,created_at,updated_at) VALUES (?,?,?,?,?,'pending',?,?,?)")
      .run(id, this.identity.householdId, chatId, dedupeKey, serialized({ text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }), this.now(), this.now(), this.now()).changes;
    return changes ? id : null;
  }
  claimOutbox() {
    return this.transaction(() => {
      const nextSendAt = Number(this.db.prepare("SELECT value FROM metadata WHERE key='telegram_next_send_at'").get()?.value ?? 0);
      if (this.now() < nextSendAt) return null;
      const row = this.db.prepare("SELECT * FROM outbox WHERE household_id=? AND state='pending' AND available_at<=? ORDER BY created_at,rowid LIMIT 1").get(this.identity.householdId, this.now());
      if (!row) return null;
      if (row.chat_id !== this.identity.chatId) throw new AppError('UNAUTHORIZED');
      this.db.prepare("UPDATE outbox SET state='sending',attempts=attempts+1,updated_at=? WHERE id=?").run(this.now(), row.id);
      this.db.prepare("INSERT INTO metadata VALUES ('telegram_next_send_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(this.now() + 1100));
      return decode({ ...row, attempts: row.attempts + 1 });
    });
  }
  deferOutbox(id, retryAfterSeconds) {
    if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 3600) throw new AppError('INPUT_INVALID');
    this.transaction(() => {
      const availableAt = this.now() + retryAfterSeconds * 1000;
      this.db.prepare("UPDATE outbox SET state='pending',available_at=?,updated_at=?,error_code='TELEGRAM_RATE_LIMITED' WHERE id=? AND household_id=? AND state='sending'").run(availableAt, this.now(), id, this.identity.householdId);
      this.db.prepare("INSERT INTO metadata VALUES ('telegram_next_send_at',?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)").run(String(availableAt));
    });
  }
  finishOutbox(id, { state, messageId = null, code = null }) {
    if (!['sent', 'failed', 'uncertain'].includes(state)) throw new AppError('INPUT_INVALID');
    this.db.prepare("UPDATE outbox SET state=?,message_id=?,error_code=?,updated_at=? WHERE id=? AND household_id=? AND state='sending'").run(state, messageId, code == null ? null : safeCode(code), this.now(), id, this.identity.householdId);
  }
  recover() {
    this.transaction(() => {
      const completed = this.db.prepare(`SELECT j.id,j.attempts FROM jobs j JOIN operations o ON o.confirmation_job_id=j.id
        WHERE j.state='running' AND o.state IN ('applied','failed_before','uncertain','simulated','observed_after','observed_before')
        AND EXISTS(SELECT 1 FROM outbox x WHERE x.dedupe_key='operation-result:'||o.id||':0')`).all();
      for (const job of completed) {
        this.db.prepare("UPDATE jobs SET state='done',updated_at=? WHERE id=?").run(this.now(), job.id);
        this.db.prepare("UPDATE job_attempts SET outcome='done',finished_at=? WHERE job_id=? AND attempt=?").run(this.now(), job.id, job.attempts);
      }
      this.db.prepare("UPDATE jobs SET state=CASE WHEN safe_retry=1 THEN 'queued' ELSE 'uncertain' END,updated_at=? WHERE state='running'").run(this.now());
      this.db.prepare("UPDATE outbox SET state='uncertain',error_code='DELIVERY_UNCERTAIN',updated_at=? WHERE state='sending'").run(this.now());
      recoverOperations(this);
      recoverAssistantActions(this);
    });
  }
  setPreference(key, value) { if (!keyValid(key)) throw new AppError('INPUT_INVALID'); this.db.prepare('INSERT INTO preferences VALUES (?,?,?) ON CONFLICT(household_id,key) DO UPDATE SET value=excluded.value').run(this.identity.householdId, key, serialized(value)); }
  getPreference(key, fallback = null) { const row = this.db.prepare('SELECT value FROM preferences WHERE household_id=? AND key=?').get(this.identity.householdId, key); return row ? JSON.parse(row.value) : fallback; }
  saveSnapshot(snapshot) {
    if (snapshot.householdId !== this.identity.householdId || snapshot.budgetId !== this.identity.budgetId) throw new AppError('UNAUTHORIZED');
    this.db.prepare('INSERT INTO snapshots VALUES (?,?,?,?,?)').run(snapshot.id, snapshot.householdId, snapshot.budgetId, this.now(), serialized(snapshot, 64 * 1024 * 1024));
  }
  latestSnapshot() { const row = this.db.prepare('SELECT payload FROM snapshots WHERE household_id=? AND budget_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(this.identity.householdId, this.identity.budgetId); return row ? JSON.parse(row.payload) : null; }
  status() {
    return {
      queued: this.db.prepare("SELECT COUNT(*) n FROM jobs WHERE state='queued'").get().n,
      uncertainDeliveries: this.db.prepare("SELECT COUNT(*) n FROM outbox WHERE state='uncertain'").get().n,
      uncertainOperations: this.db.prepare("SELECT COUNT(*) n FROM operations WHERE state='uncertain'").get().n,
      observedOperations: this.db.prepare("SELECT COUNT(*) n FROM operations WHERE state IN ('observed_after','observed_before')").get().n,
      assistantUncertainOperations: this.db.prepare("SELECT COUNT(*) n FROM assistant_action_operations WHERE state='uncertain'").get().n,
      assistantPartialOperations: this.db.prepare("SELECT COUNT(*) n FROM assistant_action_operations WHERE state='partial'").get().n,
      lastSnapshotAt: this.db.prepare('SELECT MAX(created_at) at FROM snapshots').get().at ?? null
    };
  }
  prune(retentionDays = 90) {
    this.transaction(() => {
      const yesterday = this.now() - 86400000;
      this.db.prepare("UPDATE jobs SET payload=NULL WHERE state IN ('done','failed') AND updated_at<?").run(yesterday);
      this.db.prepare("UPDATE outbox SET payload=NULL WHERE state='sent' AND updated_at<?").run(yesterday);
      this.db.prepare('DELETE FROM snapshots WHERE created_at<?').run(this.now() - retentionDays * 86400000);
      pruneOperations(this, retentionDays);
      pruneAssistantActions(this, retentionDays);
      pruneConversations(this, this.conversationConfig);
    });
  }
  heartbeat() { this.db.prepare("INSERT INTO metadata VALUES ('heartbeat_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(this.now())); }
  async backup(filename) { await this.db.backup(filename); }
}
