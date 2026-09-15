import { createHash, randomUUID } from 'node:crypto';
import { AppError,ERROR_CODES } from '../errors.mjs';
import { validDate } from '../actual/snapshot.mjs';
import { splitMessage } from '../storage/store.mjs';
import { withActionMetadata } from '../categorization/response.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rank = { none:0,warning:1,critical:2 };
const RULE_VERSION = 'daily-alerts-v1';
export const MAX_ALERTS_PER_SCAN = 20;

export class ReportStore {
  constructor(store) { this.store=store; this.db=store.db; }
  reserve(kind, slot, prefs) {
    const identity=this.store.identity;
    return this.store.transaction(() => {
      const old=this.db.prepare('SELECT id FROM report_occurrences WHERE household_id=? AND budget_id=? AND kind=? AND slot_key=?').get(identity.householdId,identity.budgetId,kind,slot.key);
      if (old) return null;
      const latest=this.db.prepare('SELECT MAX(scheduled_at) at FROM report_occurrences WHERE household_id=? AND budget_id=? AND kind=?').get(identity.householdId,identity.budgetId,kind).at;
      if (latest!=null&&slot.instant<=latest) return null;
      this.db.prepare("UPDATE jobs SET state='done',updated_at=? WHERE state='queued' AND id IN (SELECT job_id FROM report_occurrences WHERE kind=? AND state='pending' AND scheduled_at<?)").run(this.store.now(),kind,slot.instant);
      this.db.prepare("UPDATE report_occurrences SET state='cancelled',completed_at=? WHERE kind=? AND state='pending' AND scheduled_at<?").run(this.store.now(),kind,slot.instant);
      if (kind==='daily') {
        this.db.prepare(`UPDATE report_deliveries SET cancelled=1 WHERE kind='daily' AND outbox_id IN (SELECT id FROM outbox WHERE state='pending')
          AND occurrence_id IN (SELECT id FROM report_occurrences WHERE kind='daily' AND scheduled_at<?)`).run(slot.instant);
        this.db.prepare("UPDATE outbox SET state='failed',updated_at=? WHERE state='pending' AND id IN (SELECT outbox_id FROM report_deliveries WHERE cancelled=1)").run(this.store.now());
      }
      const id=randomUUID(), policyRevision=kind==='daily'?prefs.scheduleRevision:prefs.alertsRevision;
      this.db.prepare("INSERT INTO report_occurrences(id,household_id,budget_id,kind,slot_key,scheduled_at,report_date,policy_revision,state,created_at) VALUES (?,?,?,?,?,?,?,?,'pending',?)").run(id,identity.householdId,identity.budgetId,kind,slot.key,slot.instant,slot.reportDate,policyRevision,this.store.now());
      const jobId=this.store.enqueueJob({kind:kind==='daily'?'daily_report':'alert_scan',payload:{identity,occurrenceId:id},dedupeKey:`report:${hash([identity.householdId,identity.budgetId,kind,slot.key])}`,priority:kind==='daily'?-10:-20,safeRetry:true});
      if (!jobId) throw new AppError('STORAGE_FAILED');
      this.db.prepare('UPDATE report_occurrences SET job_id=? WHERE id=?').run(jobId,id);
      return {id,jobId};
    });
  }
  occurrence(job) {
    this.store.assertIdentity(job.payload?.identity ?? {});
    const row=this.db.prepare('SELECT * FROM report_occurrences WHERE id=? AND job_id=? AND household_id=? AND budget_id=?').get(job.payload.occurrenceId,job.id,this.store.identity.householdId,this.store.identity.budgetId);
    if (!row || job.kind!==(row.kind==='daily'?'daily_report':'alert_scan')) throw new AppError('UNAUTHORIZED');
    return row;
  }
  trackedAlerts(snapshot) {
    // Retain old state, but only pass targets covered by this read or present
    // under the same ID after being re-dated. Never infer recovery from ageing.
    const rows=this.db.prepare(`SELECT type,target_id AS targetId,competence FROM alert_state
      WHERE household_id=? AND budget_id=? AND type='anomaly' AND severity<>'none'
      AND (competence BETWEEN ? AND ? OR target_id IN (SELECT value FROM json_each(?))) LIMIT 10001`).all(this.store.identity.householdId,this.store.identity.budgetId,snapshot.period.start,snapshot.period.end,JSON.stringify(snapshot.transactions.map(row=>row.id)));
    if (rows.length>10000) throw new AppError('SNAPSHOT_INVALID');
    return rows;
  }
  applyCandidates(occurrence,candidates,snapshotId,{durationMs}) {
    if (!Array.isArray(candidates) || candidates.length>100000) throw new AppError('SNAPSHOT_INVALID');
    const identity=this.store.identity,seen=new Set(),messages=[];
    for (const c of candidates) {
      if (!c || !['budget','low_balance','anomaly'].includes(c.type) || typeof c.targetId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(c.targetId) || !Object.hasOwn(rank,c.severity) || typeof c.reset?.warning!=='boolean' || typeof c.reset?.critical!=='boolean' || typeof c.text!=='string' || c.text.length>12000) throw new AppError('SNAPSHOT_INVALID');
      if ((c.type==='budget'&&!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(c.competence)) || (c.type==='low_balance'&&c.competence!=='continuous') || (c.type==='anomaly'&&!validDate(c.competence))) throw new AppError('SNAPSHOT_INVALID');
      const key=hash([identity.householdId,identity.budgetId,identity.userId,identity.chatId,RULE_VERSION,c.type,c.targetId,c.competence]);
      if (seen.has(key)) throw new AppError('SNAPSHOT_INVALID'); seen.add(key);
      const old=this.db.prepare('SELECT * FROM alert_state WHERE state_key=?').get(key), before=old?.severity??'none';
      const after=rank[c.severity]<rank[before] && !c.reset[before] ? before : c.severity;
      const changed=before!==after,notify=rank[after]>rank[before];
      // Overflow remains unadvanced so a fresh later scan can still notify it.
      if (notify&&messages.length>=MAX_ALERTS_PER_SCAN) continue;
      const episode=(old?.episode??0)+(before==='none'&&after!=='none'?1:0), index=(old?.transition_index??0)+(changed?1:0);
      this.db.prepare(`INSERT INTO alert_state(state_key,household_id,budget_id,rule_version,type,target_id,competence,severity,episode,transition_index,last_observed_at,snapshot_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(state_key) DO UPDATE SET severity=excluded.severity,episode=excluded.episode,transition_index=excluded.transition_index,last_observed_at=excluded.last_observed_at,snapshot_id=excluded.snapshot_id`).run(key,identity.householdId,identity.budgetId,RULE_VERSION,c.type,c.targetId,c.competence,after,episode,index,this.store.now(),snapshotId);
      if (changed) this.db.prepare('INSERT INTO alert_transitions(id,state_key,occurrence_id,episode,transition_index,before_severity,after_severity,created_at,snapshot_id) VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(),key,occurrence.id,episode,index,before,after,this.store.now(),snapshotId);
      if (changed) {
        this.db.prepare(`UPDATE report_deliveries SET cancelled=1 WHERE alert_state_key=? AND alert_transition_index<>?
          AND outbox_id IN (SELECT id FROM outbox WHERE state='pending')`).run(key,index);
        this.db.prepare("UPDATE outbox SET state='failed',updated_at=? WHERE state='pending' AND id IN (SELECT outbox_id FROM report_deliveries WHERE alert_state_key=? AND cancelled=1)").run(this.store.now(),key);
      }
      if (notify) messages.push(withActionMetadata({text:`Alerta: ${after==='critical'?'crítico':'atenção'}.\n${c.text}`,dedupeKey:`alert:${key}:${episode}:${index}:${after}`,alertStateKey:key,alertTransitionIndex:index},{reason:'alert_transition',durationMs}));
    }
    return messages;
  }
  complete(job,occurrence,{state='completed',snapshotId=null,dataState=null,scope,messages=[],candidates=null,durationMs=null,code=null}) {
    return this.store.transaction(() => {
      const row=this.db.prepare("SELECT * FROM jobs WHERE id=? AND state='running'").get(job.id);
      if (!row) throw new AppError('STORAGE_FAILED');
      const current=this.occurrence(job);
      if (current.state!=='pending') { this.store.completeJob(job.id); return; }
      const all=[...messages,...(candidates?this.applyCandidates(occurrence,candidates,snapshotId,{durationMs}):[])];
      for (const message of all) {
        const chunks=splitMessage(message.text);
        chunks.forEach((text,index) => {
          const dedupeKey=`${message.dedupeKey??`daily:${occurrence.id}`}:${index}`;
          const outboxId=this.store.enqueueOutbox({text,dedupeKey}) ?? this.db.prepare('SELECT id FROM outbox WHERE dedupe_key=?').get(dedupeKey)?.id;
          if (!outboxId) throw new AppError('STORAGE_FAILED');
          this.db.prepare('INSERT OR IGNORE INTO report_deliveries(outbox_id,occurrence_id,kind,policy_revision,scope_json,alert_state_key,alert_transition_index) VALUES (?,?,?,?,?,?,?)').run(outboxId,occurrence.id,occurrence.kind,occurrence.policy_revision,JSON.stringify(scope),message.alertStateKey??null,message.alertTransitionIndex??null);
        });
      }
      this.db.prepare('UPDATE report_occurrences SET state=?,completed_at=?,snapshot_id=?,data_state=? WHERE id=?').run(state,this.store.now(),snapshotId,dataState,occurrence.id);
      this.store.completeJob(job.id);
      if (code) this.db.prepare('UPDATE jobs SET error_code=? WHERE id=?').run(ERROR_CODES.has(code)?code:'INTERNAL_ERROR',job.id);
    });
  }
  cancel(job) {
    this.store.transaction(() => {
      this.db.prepare("UPDATE report_occurrences SET state='cancelled',completed_at=? WHERE job_id=? AND state='pending'").run(this.store.now(),job.id);
      this.store.completeJob(job.id);
    });
  }
  status() {
    const latest=kind=>this.db.prepare('SELECT r.scheduled_at,r.completed_at,r.state,r.data_state,j.error_code FROM report_occurrences r LEFT JOIN jobs j ON j.id=r.job_id WHERE r.kind=? ORDER BY r.scheduled_at DESC LIMIT 1').get(kind)??null;
    return {daily:latest('daily'),alerts:latest('alerts')};
  }
  prune(retentionDays) {
    if (!Number.isSafeInteger(retentionDays)||retentionDays<1) throw new AppError('CONFIG_INVALID');
    this.db.prepare(`UPDATE outbox SET payload=NULL WHERE state IN ('sent','failed','uncertain') AND updated_at<?
      AND id IN (SELECT outbox_id FROM report_deliveries)`).run(this.store.now()-retentionDays*86400000);
  }
}
