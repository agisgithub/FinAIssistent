import { randomUUID } from 'node:crypto';
import { AppError, errorCode } from '../errors.mjs';
import { localToday } from '../finance/periods.mjs';
import { formatMoney } from '../finance/money.mjs';
import { label } from '../reports/render.mjs';
import { automaticCandidate, automaticPolicyHash, recommendCategories } from '../categorization/recommend.mjs';
import {
  TRANSACTION_SCAN_AUTOMATIC_LIMIT, TRANSACTION_SCAN_INTERVAL_MS, TRANSACTION_SCAN_QUESTION_LIMIT,
  TRANSACTION_SCAN_LOOKBACK_MONTHS,
  assertMonitorSnapshot, memoryHint, monitorInspection, monitorKey
} from '../categorization/monitor.mjs';

const readJson = value => { try { return value == null ? null : JSON.parse(value); } catch { throw new AppError('STORAGE_FAILED'); } };
const automaticStates = new Set(['pending','auto_queued','question_queued','questioned']);
const terminalStates = new Set(['applied','uncertain']);
const decisionValue = options => options.map(({ categoryId, source, score, confidence, evidence }) => ({ categoryId, source, score, confidence, evidence }));

export class TransactionMonitorScheduler {
  constructor({ config, store, actual, actions, companionService = null, now = () => store.now() }) {
    Object.assign(this, { config, store, actual, actions, companionService, now });
    this.identity = store.identity;
  }
  enabled() { return this.config.companion.transactionMonitorEnabled === true; }
  owns(job) { return ['transaction_scan','transaction_question','automatic_category'].includes(job.kind); }
  tick() {
    if (!this.enabled()) return [];
    const slot = Math.floor(this.now() / TRANSACTION_SCAN_INTERVAL_MS) * TRANSACTION_SCAN_INTERVAL_MS;
    const state = this.store.db.prepare('SELECT last_slot FROM transaction_monitor_state WHERE household_id=? AND budget_id=?').get(this.identity.householdId, this.identity.budgetId);
    if (state && state.last_slot >= slot) return [];
    return this.store.transaction(() => {
      const jobId = this.store.enqueueJob({ kind: 'transaction_scan', payload: { identity: this.identity, slot }, dedupeKey: `transaction-scan:${monitorKey([this.identity.householdId,this.identity.budgetId,slot])}`, safeRetry: true, priority: -20 });
      if (!jobId) return [];
      this.store.db.prepare(`INSERT INTO transaction_monitor_runs(id,household_id,budget_id,slot,job_id,state,created_at)
        VALUES (?,?,?,?,?,'pending',?)`).run(randomUUID(), this.identity.householdId, this.identity.budgetId, slot, jobId, this.now());
      return [jobId];
    });
  }
  period() {
    const end = localToday(this.config.timezone, new Date(this.now()));
    const startDate = new Date(`${end}T12:00:00Z`);
    startDate.setUTCDate(1);
    startDate.setUTCMonth(startDate.getUTCMonth() - (TRANSACTION_SCAN_LOOKBACK_MONTHS - 1));
    return { start: startDate.toISOString().slice(0, 10), end };
  }
  cancelObservation(row) {
    if (row.job_id) {
      this.store.db.prepare("UPDATE jobs SET state='done',updated_at=? WHERE id=? AND state='queued'").run(this.now(), row.job_id);
      this.store.db.prepare("UPDATE proposals SET state='expired' WHERE source_job_id=? AND state='pending'").run(row.job_id);
    }
    for (const delivery of this.store.db.prepare('SELECT outbox_id FROM transaction_monitor_deliveries WHERE household_id=? AND budget_id=? AND transaction_id=? AND cancelled=0').all(row.household_id,row.budget_id,row.transaction_id)) {
      this.store.db.prepare('UPDATE transaction_monitor_deliveries SET cancelled=1 WHERE outbox_id=?').run(delivery.outbox_id);
      this.store.db.prepare("UPDATE outbox SET state='failed',updated_at=? WHERE id=? AND state='pending'").run(this.now(),delivery.outbox_id);
    }
  }
  reserveDecision(observation, inspection, history, counters, slot) {
    const options = recommendCategories({ inspection, rules: this.config.categorization.rules, examples: this.actions.journal.examples(), history });
    const candidate = automaticCandidate(options), decision = JSON.stringify({ recommendations: decisionValue(options) });
    if (candidate && this.config.companion.autoCategorizeHighConfidence) {
      if (counters.automatic >= TRANSACTION_SCAN_AUTOMATIC_LIMIT) return;
      const policyHash = automaticPolicyHash(this.config);
      const jobId = this.store.enqueueJob({ kind: 'automatic_category', payload: { identity: this.identity, transactionId: observation.transaction_id, fingerprint: inspection.fingerprint, categoryId: candidate.categoryId, policyHash }, dedupeKey: `automatic-category:${monitorKey([this.identity.budgetId,observation.transaction_id,inspection.fingerprint,policyHash,slot])}`, safeRetry: true, priority: 10 });
      if (!jobId) return;
      this.store.db.prepare("UPDATE transaction_observations SET state='auto_queued',decision_json=?,job_id=?,last_seen_at=? WHERE household_id=? AND budget_id=? AND transaction_id=? AND state='pending'").run(decision,jobId,this.now(),this.identity.householdId,this.identity.budgetId,observation.transaction_id);
      counters.automatic++;
      return;
    }
    if (counters.questions >= TRANSACTION_SCAN_QUESTION_LIMIT) return;
    const jobId = this.store.enqueueJob({ kind: 'transaction_question', payload: { identity: this.identity, transactionId: observation.transaction_id, fingerprint: inspection.fingerprint }, dedupeKey: `transaction-question:${monitorKey([this.identity.budgetId,observation.transaction_id,inspection.fingerprint,slot])}`, safeRetry: true, priority: 5 });
    if (!jobId) return;
    this.store.db.prepare("UPDATE transaction_observations SET state='question_queued',decision_json=?,job_id=?,last_seen_at=? WHERE household_id=? AND budget_id=? AND transaction_id=? AND state='pending'").run(decision,jobId,this.now(),this.identity.householdId,this.identity.budgetId,observation.transaction_id);
    counters.questions++;
  }
  commitSnapshot(job, snapshot, period) {
    return this.store.transaction(() => {
      const run = this.store.db.prepare("SELECT * FROM transaction_monitor_runs WHERE job_id=? AND state='pending'").get(job.id);
      if (!run) throw new AppError('STORAGE_FAILED');
      const state = this.store.db.prepare('SELECT * FROM transaction_monitor_state WHERE household_id=? AND budget_id=?').get(this.identity.householdId,this.identity.budgetId);
      const inspections = new Map(snapshot.transactions.map(transaction => [transaction.id, monitorInspection(snapshot, transaction, this.config)]));
      if (!state) {
        const insert = this.store.db.prepare(`INSERT INTO transaction_observations(household_id,budget_id,user_id,chat_id,transaction_id,first_fingerprint,latest_fingerprint,state,first_seen_at,last_seen_at)
          VALUES (?,?,?,?,?,?,?,'baseline',?,?)`);
        for (const inspection of inspections.values()) insert.run(this.identity.householdId,this.identity.budgetId,this.identity.userId,this.identity.chatId,inspection.transaction.id,inspection.fingerprint,inspection.fingerprint,this.now(),this.now());
        this.store.db.prepare('INSERT INTO transaction_monitor_state VALUES (?,?,?,?,?,?,?)').run(this.identity.householdId,this.identity.budgetId,this.now(),this.now(),job.payload.slot,snapshot.id,snapshot.syncedAt);
        this.store.db.prepare("UPDATE transaction_monitor_runs SET state='completed',baseline=1,completed_at=?,snapshot_id=?,synced_at=? WHERE id=?").run(this.now(),snapshot.id,snapshot.syncedAt,run.id);
        this.store.completeJob(job.id);
        return { baseline: true, observed: inspections.size };
      }
      const existing = new Map(this.store.db.prepare('SELECT * FROM transaction_observations WHERE household_id=? AND budget_id=?').all(this.identity.householdId,this.identity.budgetId).map(row => [row.transaction_id,row]));
      const insert = this.store.db.prepare(`INSERT INTO transaction_observations(household_id,budget_id,user_id,chat_id,transaction_id,first_fingerprint,latest_fingerprint,state,first_seen_at,last_seen_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      for (const old of existing.values()) if (automaticStates.has(old.state) && !inspections.has(old.transaction_id)) {
        this.cancelObservation(old);
        this.store.db.prepare("UPDATE transaction_observations SET state='ignored',decision_json=NULL,job_id=NULL,operation_id=NULL,last_seen_at=? WHERE household_id=? AND budget_id=? AND transaction_id=?").run(this.now(),this.identity.householdId,this.identity.budgetId,old.transaction_id);
      }
      for (const [transactionId, inspection] of inspections) {
        const old = existing.get(transactionId);
        if (!old) {
          insert.run(this.identity.householdId,this.identity.budgetId,this.identity.userId,this.identity.chatId,transactionId,inspection.fingerprint,inspection.fingerprint,inspection.eligibility.eligible?'pending':'ignored',this.now(),this.now());
          continue;
        }
        if (terminalStates.has(old.state) || old.state === 'baseline' || old.state === 'ignored' && old.latest_fingerprint === inspection.fingerprint) {
          this.store.db.prepare('UPDATE transaction_observations SET last_seen_at=? WHERE household_id=? AND budget_id=? AND transaction_id=?').run(this.now(),this.identity.householdId,this.identity.budgetId,transactionId);
          continue;
        }
        if (inspection.transaction.categoryId !== null) {
          this.cancelObservation(old);
          this.store.db.prepare("UPDATE transaction_observations SET state='resolved_external',latest_fingerprint=?,job_id=NULL,last_seen_at=? WHERE household_id=? AND budget_id=? AND transaction_id=?").run(inspection.fingerprint,this.now(),this.identity.householdId,this.identity.budgetId,transactionId);
          continue;
        }
        if (!inspection.eligibility.eligible) {
          this.cancelObservation(old);
          this.store.db.prepare("UPDATE transaction_observations SET state='ignored',latest_fingerprint=?,decision_json=NULL,job_id=NULL,last_seen_at=? WHERE household_id=? AND budget_id=? AND transaction_id=?").run(inspection.fingerprint,this.now(),this.identity.householdId,this.identity.budgetId,transactionId);
          continue;
        }
        if (old.state === 'failed_before') {
          this.cancelObservation(old);
          this.store.db.prepare("UPDATE transaction_observations SET state='pending',latest_fingerprint=?,decision_json=NULL,job_id=NULL,operation_id=NULL,last_seen_at=? WHERE household_id=? AND budget_id=? AND transaction_id=?").run(inspection.fingerprint,this.now(),this.identity.householdId,this.identity.budgetId,transactionId);
          continue;
        }
        if (old.latest_fingerprint !== inspection.fingerprint) {
          this.cancelObservation(old);
          this.store.db.prepare('UPDATE transaction_observations SET state=?,latest_fingerprint=?,decision_json=NULL,job_id=NULL,operation_id=NULL,last_seen_at=? WHERE household_id=? AND budget_id=? AND transaction_id=?').run(inspection.eligibility.eligible?'pending':'ignored',inspection.fingerprint,this.now(),this.identity.householdId,this.identity.budgetId,transactionId);
        } else this.store.db.prepare('UPDATE transaction_observations SET last_seen_at=? WHERE household_id=? AND budget_id=? AND transaction_id=?').run(this.now(),this.identity.householdId,this.identity.budgetId,transactionId);
      }
      const counters = { automatic: 0, questions: 0 };
      for (const observation of this.store.db.prepare("SELECT * FROM transaction_observations WHERE household_id=? AND budget_id=? AND state='pending' ORDER BY first_seen_at,transaction_id").all(this.identity.householdId,this.identity.budgetId)) {
        const inspection = inspections.get(observation.transaction_id);
        if (!inspection) continue;
        if (!inspection.eligibility.eligible) {
          this.store.db.prepare("UPDATE transaction_observations SET state='ignored',last_seen_at=? WHERE household_id=? AND budget_id=? AND transaction_id=?").run(this.now(),this.identity.householdId,this.identity.budgetId,observation.transaction_id);
          continue;
        }
        this.reserveDecision(observation,inspection,snapshot.transactions,counters,job.payload.slot);
      }
      this.store.db.prepare('UPDATE transaction_monitor_state SET last_success_at=?,last_slot=?,last_snapshot_id=?,last_synced_at=? WHERE household_id=? AND budget_id=?').run(this.now(),job.payload.slot,snapshot.id,snapshot.syncedAt,this.identity.householdId,this.identity.budgetId);
      this.store.db.prepare("UPDATE transaction_monitor_runs SET state='completed',completed_at=?,snapshot_id=?,synced_at=? WHERE id=?").run(this.now(),snapshot.id,snapshot.syncedAt,run.id);
      this.store.completeJob(job.id);
      return { baseline: false, ...counters };
    });
  }
  async runScan(job) {
    this.store.assertIdentity(job.payload.identity);
    const latest = Math.floor(this.now() / TRANSACTION_SCAN_INTERVAL_MS) * TRANSACTION_SCAN_INTERVAL_MS;
    if (job.payload.slot < latest) { this.store.transaction(()=>{this.store.db.prepare("UPDATE transaction_monitor_runs SET state='unavailable',completed_at=? WHERE job_id=? AND state='pending'").run(this.now(),job.id);this.store.completeJob(job.id);}); this.tick(); return; }
    const period = this.period();
    try {
      const snapshot = assertMonitorSnapshot(await this.actual.snapshot(period),this.config,period);
      this.commitSnapshot(job,snapshot,period);
    } catch (error) {
      const code = errorCode(error,'ACTUAL_FAILED');
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE transaction_monitor_runs SET state='unavailable',completed_at=?,error_code=? WHERE job_id=? AND state='pending'").run(this.now(),code,job.id);
        this.store.completeJob(job.id);
        this.store.db.prepare('UPDATE jobs SET error_code=? WHERE id=?').run(code,job.id);
      });
    }
  }
  async runAutomatic(job) {
    this.store.assertIdentity(job.payload.identity);
    try {
      const result = await this.actions.automatic(job.payload.transactionId,{ identity:this.identity, job, expectedFingerprint:job.payload.fingerprint, expectedCategoryId:job.payload.categoryId, expectedPolicyHash:job.payload.policyHash });
      if (result.status === 'skipped') this.store.db.prepare("UPDATE transaction_observations SET state='pending',decision_json=NULL,job_id=NULL,last_seen_at=? WHERE household_id=? AND budget_id=? AND transaction_id=? AND job_id=? AND state='auto_queued'").run(this.now(),this.identity.householdId,this.identity.budgetId,job.payload.transactionId,job.id);
      this.store.completeJob(job.id);
    } catch (error) {
      const operation = this.store.db.prepare('SELECT state FROM operations WHERE confirmation_job_id=?').get(job.id);
      if (operation) throw error;
      const code = errorCode(error);
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE transaction_observations SET state='pending',decision_json=NULL,job_id=NULL,last_seen_at=? WHERE household_id=? AND budget_id=? AND transaction_id=? AND job_id=? AND state='auto_queued'").run(this.now(),this.identity.householdId,this.identity.budgetId,job.payload.transactionId,job.id);
        this.store.completeJob(job.id);
        this.store.db.prepare('UPDATE jobs SET error_code=? WHERE id=?').run(code,job.id);
      });
    }
  }
  questionText(inspection, hint) {
    const memory = hint ? hint.resolution === 'exact'
      ? `\nPista de memória: ${label(hint.subject)} associa este favorecido a ${label(hint.categoryName)}. Isso é apenas contexto e não aumentou a confiança.`
      : `\nHá ${hint.count} pistas de memória conflitantes; nenhuma foi usada para pontuar.` : '';
    return `Novo gasto sem categoria\nLançamento: ${inspection.transaction.id}\nData: ${inspection.transaction.date}; valor: ${formatMoney(-inspection.transaction.amount)}.\nFavorecido: ${label(inspection.payee?.name ?? 'não informado')}.\nConta: ${label(inspection.account.name)}.${memory}\nQual categoria devo usar?\n/sugerir ${inspection.transaction.id}\n/categorizar ${inspection.transaction.id} <categoryId>`;
  }
  async runQuestion(job) {
    this.store.assertIdentity(job.payload.identity);
    let message;
    try {
      const inspection = await this.actions.inspect(job.payload.transactionId);
      if (inspection.fingerprint !== job.payload.fingerprint || inspection.transaction.categoryId !== null) {
        this.store.transaction(() => {
          this.store.db.prepare("UPDATE transaction_observations SET state=?,latest_fingerprint=?,job_id=NULL,last_seen_at=? WHERE household_id=? AND budget_id=? AND transaction_id=? AND job_id=? AND state='question_queued'").run(inspection.transaction.categoryId!==null?'resolved_external':'pending',inspection.fingerprint,this.now(),this.identity.householdId,this.identity.budgetId,job.payload.transactionId,job.id);
          this.store.completeJob(job.id);
        }); return;
      }
      const row = this.store.db.prepare("SELECT decision_json FROM transaction_observations WHERE transaction_id=? AND job_id=? AND state='question_queued'").get(job.payload.transactionId,job.id);
      if (!row) throw new AppError('STORAGE_FAILED');
      const recommendations = readJson(row.decision_json)?.recommendations ?? [];
      const memories = this.config.companion.enabled && this.companionService ? this.companionService.repository.listMemories(this.identity,{limit:100}) : [];
      const hint = memoryHint(memories,inspection);
      if (recommendations.length === 1) {
        const candidate = recommendations[0];
        message = await this.actions.prepare(job.payload.transactionId,candidate.categoryId,{ identity:this.identity, job, expectedFingerprint:job.payload.fingerprint, reason:{ source:'monitor', recommendation:candidate, memory:hint } });
      } else message = { text:this.questionText(inspection,hint) };
      this.store.transaction(() => {
        const changed = this.store.db.prepare("UPDATE transaction_observations SET state='questioned',last_seen_at=? WHERE household_id=? AND budget_id=? AND transaction_id=? AND job_id=? AND state='question_queued'").run(this.now(),this.identity.householdId,this.identity.budgetId,job.payload.transactionId,job.id).changes;
        if (changed !== 1) throw new AppError('STORAGE_FAILED');
        this.store.completeJob(job.id,message);
        const outbox = this.store.db.prepare('SELECT id FROM outbox WHERE dedupe_key=?').get(`job:${job.id}:0`);
        if (!outbox) throw new AppError('STORAGE_FAILED');
        this.store.db.prepare('INSERT INTO transaction_monitor_deliveries VALUES (?,?,?,?,?,0)').run(outbox.id,this.identity.householdId,this.identity.budgetId,job.payload.transactionId,job.payload.fingerprint);
      });
    } catch (error) {
      if (this.store.db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id)?.state === 'done') return;
      const code=errorCode(error);
      this.store.transaction(()=>{this.store.db.prepare("UPDATE transaction_observations SET state='pending',decision_json=NULL,job_id=NULL,last_seen_at=? WHERE transaction_id=? AND job_id=? AND state='question_queued'").run(this.now(),job.payload.transactionId,job.id);this.store.completeJob(job.id);this.store.db.prepare('UPDATE jobs SET error_code=? WHERE id=?').run(code,job.id);});
    }
  }
  runJob(job) {
    if (!this.owns(job)) throw new AppError('UNAUTHORIZED');
    if (!this.enabled() || job.kind === 'automatic_category' && !this.config.companion.autoCategorizeHighConfidence) {
      this.store.transaction(()=>{
        this.store.db.prepare("UPDATE transaction_monitor_runs SET state='unavailable',completed_at=? WHERE job_id=? AND state='pending'").run(this.now(),job.id);
        this.store.db.prepare("UPDATE transaction_observations SET state='pending',decision_json=NULL,job_id=NULL,last_seen_at=? WHERE job_id=? AND state IN ('auto_queued','question_queued')").run(this.now(),job.id);
        this.store.completeJob(job.id);
      });
      return;
    }
    if (job.kind === 'transaction_scan') return this.runScan(job);
    if (job.kind === 'automatic_category') return this.runAutomatic(job);
    return this.runQuestion(job);
  }
  authorizeDelivery(row) {
    const delivery = this.store.db.prepare('SELECT * FROM transaction_monitor_deliveries WHERE outbox_id=?').get(row.id);
    if (!delivery) return true;
    const observation = this.store.db.prepare('SELECT state,latest_fingerprint FROM transaction_observations WHERE household_id=? AND budget_id=? AND transaction_id=?').get(delivery.household_id,delivery.budget_id,delivery.transaction_id);
    return this.enabled() && delivery.cancelled===0 && observation?.state==='questioned' && observation.latest_fingerprint===delivery.fingerprint;
  }
  prune(days) {
    const cutoff=this.now()-days*86400000;
    this.store.db.prepare("UPDATE transaction_observations SET decision_json=NULL WHERE last_seen_at<? AND state IN ('baseline','ignored','applied','failed_before','uncertain','resolved_external')").run(cutoff);
    this.store.db.prepare("DELETE FROM transaction_monitor_runs WHERE completed_at<? AND state IN ('completed','unavailable')").run(cutoff);
  }
  status() {
    const row=this.store.db.prepare('SELECT initialized_at,last_success_at,last_synced_at FROM transaction_monitor_state WHERE household_id=? AND budget_id=?').get(this.identity.householdId,this.identity.budgetId);
    const counts=Object.fromEntries(this.store.db.prepare('SELECT state,COUNT(*) n FROM transaction_observations WHERE household_id=? AND budget_id=? GROUP BY state').all(this.identity.householdId,this.identity.budgetId).map(value=>[value.state,value.n]));
    return { enabled:this.enabled(),automatic:this.config.companion.autoCategorizeHighConfidence===true,...row,counts };
  }
}
