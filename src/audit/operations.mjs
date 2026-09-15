import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError, ERROR_CODES } from '../errors.mjs';
import { renderOperation } from '../telegram/confirmations.mjs';
import { withActionMetadata } from '../categorization/response.mjs';

export const POLICY_VERSION = 'category-confirmation-v1';
export const PROPOSAL_TTL_MS = 15 * 60 * 1000;
export function validBackupReference(ref, kind, operationId) {
  return ref && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(ref.id) && ref.kind === kind && ref.operationId === operationId && /^[a-f0-9]{64}$/.test(ref.sha256) && Number.isSafeInteger(ref.bytes) && ref.bytes >= 40 && ref.bytes <= 512 * 1024 * 1024 + 4096 && typeof ref.createdAt === 'string' && Number.isFinite(Date.parse(ref.createdAt));
}
const json = value => { const result = JSON.stringify(value); if (Buffer.byteLength(result) > 65536) throw new AppError('INPUT_INVALID'); return result; };
const decode = row => row ? { ...row, before: row.before_json ? JSON.parse(row.before_json) : null, after: row.after_json ? JSON.parse(row.after_json) : null, display: row.display_json ? JSON.parse(row.display_json) : null, reason: row.reason_json ? JSON.parse(row.reason_json) : null, expectedCategory: row.expected_category_json ? JSON.parse(row.expected_category_json) : null } : null;
export function policyHash(config) {
  return createHash('sha256').update(json({ version: POLICY_VERSION, origin: 'telegram-category-v1', householdId: config.householdId, budgetId: config.actual.budgetId, serverURL: config.actual.serverURL, dryRun: config.dryRun, backupKeyRef: config.backup?.keyRef ?? null, rules: config.categorization?.rules ?? [], ttl: PROPOSAL_TTL_MS, patch: ['category'], externalProviders: config.privacy.externalProviders })).digest('hex');
}

export class OperationJournal {
  constructor(store) { this.store = store; this.db = store.db; }
  event(operationId, event, payload = {}) {
    this.db.prepare('INSERT INTO audit_events(id,household_id,operation_id,event,created_at,payload) VALUES (?,?,?,?,?,?)').run(randomUUID(), this.store.identity.householdId, operationId, event, this.store.now(), json(payload));
  }
  assertJob(job, identity) {
    this.store.assertIdentity(identity);
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=? AND household_id=? AND state='running'").get(job?.id ?? '', identity.householdId);
    if (!row?.payload) throw new AppError('STORAGE_FAILED');
    this.store.assertIdentity(JSON.parse(row.payload).identity ?? {});
    return row;
  }
  assertProposal(row, identity) {
    this.store.assertIdentity(identity);
    if (!row || row.household_id !== identity.householdId || row.budget_id !== identity.budgetId || row.user_id !== identity.userId || row.chat_id !== identity.chatId) throw new AppError('UNAUTHORIZED');
    return decode(row);
  }
  fromSource(job, identity) {
    this.assertJob(job, identity);
    const row = this.db.prepare('SELECT * FROM proposals WHERE source_job_id=?').get(job.id);
    return row ? this.assertProposal(row, identity) : null;
  }
  proposal(nonce, identity) { return this.assertProposal(this.db.prepare('SELECT * FROM proposals WHERE nonce=?').get(nonce), identity); }
  create(input, { identity, job, config }) {
    return this.store.transaction(() => {
      const previous = this.fromSource(job, identity);
      if (previous) return previous;
      const now = this.store.now(), id = randomUUID(), nonce = randomBytes(18).toString('base64url');
      this.db.prepare(`INSERT INTO proposals (id,nonce,source_job_id,household_id,budget_id,user_id,chat_id,kind,state,target_id,before_fingerprint,after_fingerprint,before_json,after_json,display_json,reason_json,expected_category_json,feature_key,policy_version,policy_hash,dry_run,undo_of,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, nonce, job.id, identity.householdId, identity.budgetId, identity.userId, identity.chatId, input.kind, input.before.id, input.beforeFingerprint, input.afterFingerprint, json(input.before), json(input.after), json(input.display), json(input.reason), json(input.expectedCategory), input.featureKey, POLICY_VERSION, policyHash(config), config.dryRun ? 1 : 0, input.undoOf ?? null, now, now + PROPOSAL_TTL_MS);
      this.event(null, 'proposal_created', { proposalId: id, kind: input.kind, policyHash: policyHash(config), dryRun: config.dryRun });
      return this.proposal(nonce, identity);
    });
  }
  reserve(nonce, { identity, job, config }) {
    return this.store.transaction(() => {
      this.assertJob(job, identity);
      const p = this.proposal(nonce, identity);
      if (p.state !== 'pending') throw new AppError('PROPOSAL_USED');
      if (p.expires_at <= this.store.now()) throw new AppError('PROPOSAL_EXPIRED');
      if (p.policy_version !== POLICY_VERSION || p.policy_hash !== policyHash(config)) throw new AppError('PROPOSAL_POLICY_CHANGED');
      if (!p.before || !p.after) throw new AppError('PROPOSAL_EXPIRED');
      if (p.kind === 'undo' && this.latestTargetOperation(p.target_id)?.id !== p.undo_of) throw new AppError('UNDO_UNAVAILABLE');
      const operationId = randomUUID(), now = this.store.now();
      this.db.prepare("UPDATE proposals SET state='approved',consumed_at=? WHERE id=? AND state='pending'").run(now, p.id);
      this.db.prepare(`INSERT INTO operations(id,household_id,budget_id,kind,state,created_at,updated_at,proposal_id,confirmation_job_id,policy_hash,dry_run,undo_of)
        VALUES (?,?,?,?,'reserved',?,?,?,?,?,?,?)`).run(operationId, identity.householdId, identity.budgetId, p.kind, now, now, p.id, job.id, p.policy_hash, p.dry_run, p.undo_of);
      this.db.prepare("INSERT INTO operation_items(operation_id,target_id,before_json,after_json,state,before_fingerprint,after_fingerprint) VALUES (?,?,?,?,'reserved',?,?)").run(operationId, p.target_id, p.before_json, p.after_json, p.before_fingerprint, p.after_fingerprint);
      this.db.prepare('UPDATE jobs SET safe_retry=0,updated_at=? WHERE id=?').run(now, job.id);
      if (!p.dry_run) {
        this.db.prepare('UPDATE category_examples SET active=0 WHERE household_id=? AND budget_id=? AND target_id=?').run(identity.householdId, identity.budgetId, p.target_id);
        this.db.prepare("INSERT INTO operation_target_order(household_id,budget_id,target_id,operation_id,operation_kind) VALUES(?,?,?,?,'category')").run(identity.householdId,identity.budgetId,p.target_id,operationId);
      }
      this.event(operationId, 'approval_consumed', { proposalId: p.id, policyHash: p.policy_hash, beforeFingerprint: p.before_fingerprint, afterFingerprint: p.after_fingerprint });
      this.store.enqueueOutbox(withActionMetadata({ text: `Aprovação recebida. Operação ${operationId} em processamento${p.dry_run ? ' (simulação)' : ''}. Aguarde a verificação do resultado.`, dedupeKey: `operation-start:${operationId}` }, { reason: 'approval_received' }));
      return { proposal: p, operationId };
    });
  }
  cancel(nonce, identity) {
    return this.store.transaction(() => {
      const p = this.proposal(nonce, identity);
      if (p.state !== 'pending') throw new AppError('PROPOSAL_USED');
      this.db.prepare("UPDATE proposals SET state='cancelled',consumed_at=? WHERE id=?").run(this.store.now(), p.id);
      this.event(null, 'proposal_cancelled', { proposalId: p.id });
      return p.id;
    });
  }
  executing(operationId, stateBackupRef) {
    this.store.transaction(() => {
      const changed = this.db.prepare("UPDATE operations SET state='executing',state_backup_ref=?,updated_at=? WHERE id=? AND state='reserved'").run(json(stateBackupRef), this.store.now(), operationId).changes;
      if (changed !== 1) throw new AppError('STORAGE_FAILED');
      this.db.prepare("UPDATE operation_items SET state='executing' WHERE operation_id=?").run(operationId);
      this.event(operationId, 'state_backup_ready');
    });
  }
  finish(operationId, { state, code = null, actualBackupRef = null, durationMs = null }) {
    if (!['applied','failed_before','uncertain','simulated'].includes(state)) throw new AppError('INPUT_INVALID');
    return this.store.transaction(() => {
      const op = this.operation(operationId);
      if (!['reserved','executing'].includes(op.state)) throw new AppError('STORAGE_FAILED');
      const safeCode = code == null ? null : ERROR_CODES.has(code) ? code : 'MUTATION_UNCERTAIN';
      this.db.prepare('UPDATE operations SET state=?,initial_outcome=?,error_code=?,actual_backup_ref=?,updated_at=? WHERE id=?').run(state, state, safeCode, actualBackupRef == null ? null : json(actualBackupRef), this.store.now(), operationId);
      this.db.prepare('UPDATE operation_items SET state=? WHERE operation_id=?').run(state, operationId);
      if (state === 'applied' && !op.dry_run) {
        if (op.kind === 'undo') this.db.prepare('UPDATE category_examples SET active=0 WHERE household_id=? AND budget_id=? AND target_id=?').run(op.household_id, op.budget_id, op.target_id);
        else {
          const p = this.db.prepare('SELECT feature_key FROM proposals WHERE id=?').get(op.proposal_id);
          this.db.prepare('UPDATE category_examples SET active=0 WHERE household_id=? AND budget_id=? AND target_id=?').run(op.household_id, op.budget_id, op.target_id);
          if (p.feature_key && op.after.categoryId != null) this.db.prepare('INSERT INTO category_examples(operation_id,household_id,budget_id,target_id,feature_key,category_id,active,created_at) VALUES (?,?,?,?,?,?,1,?)').run(operationId, op.household_id, op.budget_id, op.target_id, p.feature_key, op.after.categoryId, this.store.now());
        }
      }
      this.event(operationId, `operation_${state}`, { code: safeCode });
      const finished = this.operation(operationId);
      const finalMessage = withActionMetadata(renderOperation(finished), { reason: 'operation_result', durationMs, failure: safeCode });
      this.store.enqueueOutbox({ ...finalMessage, dedupeKey: `operation-result:${operationId}:0` });
      return { ...finished, finalMessage };
    });
  }
  operation(id) {
    const row = this.db.prepare(`SELECT o.*,i.target_id,i.before_json,i.after_json,i.before_fingerprint,i.after_fingerprint,i.observed_fingerprint,i.observed_at,i.reconciliation
      FROM operations o JOIN operation_items i ON i.operation_id=o.id WHERE o.id=? AND o.household_id=? AND o.budget_id=?`).get(id, this.store.identity.householdId, this.store.identity.budgetId);
    if (!row) throw new AppError('OPERATION_NOT_FOUND');
    return decode(row);
  }
  operations() { return this.db.prepare('SELECT id,state,kind,created_at,error_code FROM operations WHERE household_id=? AND budget_id=? ORDER BY created_at DESC,rowid DESC').all(this.store.identity.householdId, this.store.identity.budgetId); }
  latestTargetOperation(targetId) {
    const latest=this.db.prepare(`SELECT r.operation_id AS id FROM operation_target_order r
      LEFT JOIN operations o ON r.operation_kind='category' AND o.id=r.operation_id
      LEFT JOIN assistant_action_targets a ON r.operation_kind='assistant' AND a.operation_id=r.operation_id AND a.target_id=r.target_id
      WHERE r.target_id=? AND r.household_id=? AND r.budget_id=? AND
      ((o.dry_run=0 AND o.state IN ('applied','uncertain','observed_after','observed_before','reserved','executing')) OR a.state IN ('applied','uncertain','reserved','executing'))
      ORDER BY r.sequence DESC LIMIT 1`).get(targetId,this.store.identity.householdId,this.store.identity.budgetId);
    // Operations written before migration005 retain their original ordering.
    return latest??this.db.prepare(`SELECT o.id FROM operations o JOIN operation_items i ON i.operation_id=o.id WHERE i.target_id=? AND o.household_id=? AND o.budget_id=? AND o.dry_run=0 AND o.state IN ('applied','uncertain','observed_after','observed_before','reserved','executing') ORDER BY o.created_at DESC,o.rowid DESC LIMIT 1`).get(targetId, this.store.identity.householdId, this.store.identity.budgetId);
  }
  examples() { return this.db.prepare('SELECT * FROM category_examples WHERE household_id=? AND budget_id=? AND active=1').all(this.store.identity.householdId, this.store.identity.budgetId); }
  observe(operationId, fingerprint) {
    return this.store.transaction(() => {
      const op = this.operation(operationId);
      const result = fingerprint === op.before_fingerprint ? 'observed_before' : fingerprint === op.after_fingerprint ? 'observed_after' : 'diverged';
      this.db.prepare('UPDATE operation_items SET observed_fingerprint=?,observed_at=?,reconciliation=? WHERE operation_id=?').run(fingerprint, this.store.now(), result, operationId);
      // Observation is a distinct outcome; it never proves execution or creates
      // an example. The first outcome and events preserve the uncertainty.
      if (op.initial_outcome === 'uncertain') {
        const state = result === 'diverged' ? 'uncertain' : result;
        this.db.prepare('UPDATE operations SET state=?,updated_at=? WHERE id=?').run(state, this.store.now(), operationId);
        this.db.prepare('UPDATE operation_items SET state=? WHERE operation_id=?').run(state, operationId);
      }
      if (result !== 'observed_after' || op.kind === 'undo') this.db.prepare('UPDATE category_examples SET active=0 WHERE household_id=? AND budget_id=? AND target_id=?').run(op.household_id, op.budget_id, op.target_id);
      this.event(operationId, 'operation_observed', { fingerprint, result });
      return { ...this.operation(operationId), reconciliation: result };
    });
  }
}

export function recoverOperations(store) {
  const rows = store.db.prepare("SELECT id FROM operations WHERE state IN ('reserved','executing','verified')").all();
  const journal = new OperationJournal(store);
  for (const row of rows) {
    store.db.prepare("UPDATE operations SET state='uncertain',initial_outcome='uncertain',error_code='MUTATION_UNCERTAIN',updated_at=? WHERE id=?").run(store.now(), row.id);
    store.db.prepare("UPDATE operation_items SET state='uncertain' WHERE operation_id=?").run(row.id);
    journal.event(row.id, 'restart_uncertain');
    store.enqueueOutbox({ ...withActionMetadata(renderOperation(journal.operation(row.id)), { reason: 'operation_recovery', failure: 'MUTATION_UNCERTAIN' }), dedupeKey: `operation-result:${row.id}:0` });
  }
}

export function pruneOperations(store, retentionDays) {
  const cutoff = store.now() - retentionDays * 86400000;
  store.db.prepare("UPDATE proposals SET state='expired' WHERE state='pending' AND expires_at<=?").run(store.now());
  store.db.prepare(`UPDATE proposals SET target_id=NULL,before_json=NULL,after_json=NULL,display_json=NULL,reason_json=NULL,expected_category_json=NULL,feature_key=NULL
    WHERE created_at<? AND state<>'pending' AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.proposal_id=proposals.id AND o.state IN ('uncertain','reserved','executing','verified'))`).run(cutoff);
  store.db.prepare(`UPDATE operation_items SET before_json=NULL,after_json=NULL WHERE operation_id IN
    (SELECT id FROM operations WHERE updated_at<? AND state IN ('applied','failed_before','simulated','observed_after','observed_before'))`).run(cutoff);
  store.db.prepare('UPDATE category_examples SET active=0,target_id=NULL,feature_key=NULL,category_id=NULL WHERE created_at<?').run(cutoff);
  store.db.prepare(`UPDATE audit_events SET payload='{"redacted":true}' WHERE created_at<? AND (operation_id IS NULL OR operation_id IN
    (SELECT id FROM operations WHERE state IN ('applied','failed_before','simulated','observed_after','observed_before')))`).run(cutoff);
}
