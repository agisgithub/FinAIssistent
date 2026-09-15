import { AppError,errorCode } from '../errors.mjs';
import { localToday } from '../finance/periods.mjs';
import { label } from '../reports/render.mjs';
import { amountText } from '../telegram/bills.mjs';
import { withActionMetadata } from '../categorization/response.mjs';
import { splitMessage } from '../storage/store.mjs';
import { evaluateVariation } from '../recurrence/match.mjs';
import { billHash } from '../recurrence/store.mjs';
import { resolveCivilTime,addCivilDays } from './civil-time.mjs';

const HOUR=3600000;
const dayDifference=(end,start)=>Math.round((Date.parse(end+'T12:00:00Z')-Date.parse(start+'T12:00:00Z'))/86400000);
export class BillScheduler {
  constructor({config,store,service,now=()=>store.now()}){Object.assign(this,{config,store,service,now});this.repository=service.repository;}
  owns(job){return job.kind==='bill_reconcile';}
  reconciliationEnabled(){return this.repository.occurrences().some(o=>{const b=this.policy(o);return o.localState==='open'&&b?.active&&(b.policy.remindersEnabled||b.policy.variationEnabled);});}
  policy(o){return this.service.effectiveBill(o.billId,o.competence);}
  slots(o,bill){
    if(!bill?.active||!bill.policy.remindersEnabled||bill.policy.since===null||o.localState!=='open')return [];
    const p=bill.policy,slots=[];
    for(const days of p.days){const slot=resolveCivilTime(addCivilDays(o.dueDate,-days),p.time,p.timezone);if(slot&&slot.instant>=p.since&&slot.instant<=this.now())slots.push({...slot,kind:'reminder',stage:String(days)});}
    if(o.dateKind==='confirmed'){const slot=resolveCivilTime(addCivilDays(o.dueDate,1),p.time,p.timezone);if(slot&&slot.instant>=p.since&&slot.instant<=this.now())slots.push({...slot,kind:'overdue',stage:'overdue'});}
    return slots.sort((a,b)=>b.instant-a.instant);
  }
  reminderText(o,bill,slot){const today=localToday(this.config.timezone,new Date(this.now())),days=dayDifference(o.dueDate,today),timing=days>0?`${o.dateKind==='confirmed'?'vence':'data estimada'} em ${days} dia(s)`:days===0?`${o.dateKind==='confirmed'?'vence':'data estimada'} hoje`:`${o.dateKind==='confirmed'?'vencimento confirmado':'data estimada'} ultrapassado há ${-days} dia(s)`;
    return withActionMetadata({text:`Calendário LOCAL — ${label(o.name)}: ${timing}.\nUnidade ${label(this.repository.unit(o.unitId).name)} (${o.unitId}); competência ${o.competence}; data ${o.dueDate} (${o.dateKind==='confirmed'?'confirmada pelo responsável':'estimada; vencimento não informado'}). Valor esperado ${amountText(o.expectedAmountCents)}.\nPagamento não confirmado manualmente; chegada de documento não verificada. Este aviso não afirma dívida ou pagamento bancário.\n/ocorrencia ${o.id}\nFonte: cadastro local ${bill.id}, revisão ${bill.revision}; aviso programado ${new Date(slot.instant).toISOString()}${this.now()>slot.instant+60000?'; envio posterior ao horário programado':''}.`},{reason:'bill_reminder'});
  }
  enqueue(o,bill,kind,slot,message,{key,matchFingerprint=null,payload={}}){
    return this.store.transaction(()=>{
      const event=this.repository.event(`notification_${kind}`,o.id,{kind,occurrenceRevision:o.revision,policyRevision:bill.policy.revision,scheduledAt:slot.instant,...payload},key);if(!event)return false;
      for(const [i,text] of splitMessage(message.text).entries()){
        const outboxId=this.store.enqueueOutbox({text,dedupeKey:`${key}:${i}`});if(!outboxId)throw new AppError('STORAGE_FAILED');
        this.store.db.prepare('INSERT INTO bill_deliveries(outbox_id,event_id,bill_id,occurrence_id,kind,occurrence_revision,policy_revision,match_fingerprint,scheduled_at) VALUES(?,?,?,?,?,?,?,?,?)').run(outboxId,event,o.billId,o.id,kind,o.revision,bill.policy.revision,matchFingerprint,slot.instant);
      }return true;
    });
  }
  cancelOld(o,filter){
    for(const row of this.store.db.prepare("SELECT d.* FROM bill_deliveries d JOIN outbox o ON o.id=d.outbox_id WHERE d.occurrence_id=? AND o.state='pending'").all(o.id))if(filter(row)){
      this.store.db.prepare('UPDATE bill_deliveries SET cancelled=1 WHERE outbox_id=?').run(row.outbox_id);this.store.db.prepare("UPDATE outbox SET state='failed',updated_at=? WHERE id=? AND state='pending'").run(this.now(),row.outbox_id);
    }
  }
  freshMatch(o,bill){const m=this.repository.match(o.id);return m&&m.state==='compatible'&&this.service.currentEvidence(m,o)&&m.observedAt>=bill.policy.since&&m.observedAt<=this.now()&&this.now()-m.observedAt<=HOUR?m:null;}
  observedKey(o,bill,m){return billHash([m.evidence,o.expectedAmountCents,m.observedAmountCents,bill.policy.variationPercent,bill.policy.variationMinimumCents,m.scope]);}
  variationText(o,bill,m,outcome){return withActionMetadata({text:`Variação de valor — ${label(o.name)}, unidade ${label(this.repository.unit(o.unitId).name)}; competência ${o.competence}.\n${outcome.direction==='increase'?'Aumento':'Redução'} em acompanhamento: referência ${amountText(o.expectedAmountCents)}, lançamento compatível ${amountText(outcome.observedAmountCents)}; diferença ${amountText(outcome.deltaCents)}. Entrada: >${bill.policy.variationPercent}% E >${amountText(bill.policy.variationMinimumCents)}; saída após reduzir até 90% do limiar de entrada.\nFonte: Actual, snapshot ${label(m.snapshotId)}, sync ${label(m.syncedAt)}; ${m.scope.includeClosed?'inclui':'exclui'} contas encerradas, ${m.scope.includeOffBudget?'inclui':'exclui'} fora do orçamento; observação ${new Date(m.observedAt).toISOString()}. Não confirma pagamento ou documento.\n/ocorrencia ${o.id}`},{reason:'bill_variation'});}
  variation(o,bill){
    if(!bill.active||!bill.policy.variationEnabled||o.localState!=='open')return;
    const m=this.freshMatch(o,bill);if(!m){const observed=this.repository.match(o.id);if(observed?.state==='none'&&this.service.currentEvidence(observed,o)&&observed.observedAt>=bill.policy.since&&observed.observedAt<=this.now()&&this.now()-observed.observedAt<=HOUR)this.store.transaction(()=>{this.cancelOld(o,row=>row.kind==='variation');this.store.db.prepare('UPDATE bill_variation_state SET active=0 WHERE occurrence_id=?').run(o.id);});return;}
    const outcome=evaluateVariation({referenceAmountCents:o.expectedAmountCents,observedAmountCents:m.observedAmountCents??null,percent:bill.policy.variationPercent,minimumCents:bill.policy.variationMinimumCents});
    if(outcome.state==='insufficient_reference')return;
    const observedKey=this.observedKey(o,bill,m),old=this.store.db.prepare('SELECT * FROM bill_variation_state WHERE occurrence_id=?').get(o.id);
    const absolute=BigInt(Math.abs(outcome.deltaCents)),reset=absolute*10n<=BigInt(bill.policy.variationMinimumCents)*9n||absolute*1000n<=BigInt(o.expectedAmountCents)*BigInt(bill.policy.variationPercent)*9n;
    const continuing=old?.active&&old.policy_revision===bill.policy.revision&&old.direction===outcome.direction&&!reset;
    const active=outcome.changed||continuing,notify=active&&(!old?.active||old.policy_revision!==bill.policy.revision||outcome.direction!==old.direction),episode=(old?.episode??0)+(notify?1:0);
    this.store.transaction(()=>{
      this.cancelOld(o,row=>row.kind==='variation'&&(!active||notify||row.policy_revision!==bill.policy.revision));
      const message=this.variationText(o,bill,m,outcome);
      const episodeKey=`bill-variation:${billHash([o.id,bill.policy.revision,episode,outcome.direction])}`;
      if(notify){
        this.enqueue(o,bill,'variation',{instant:this.now()},message,{key:episodeKey,matchFingerprint:observedKey,payload:{snapshotId:m.snapshotId}});
      }else if(active){
        // Refresh the source of an unsent episode without another notification.
        // A pre-send cancellation may resume the SAME row/episode after fresh
        // validation. Sent/uncertain or remotely rejected rows stay immutable.
        for(const row of this.store.db.prepare("SELECT d.outbox_id,d.occurrence_revision,o.state FROM bill_deliveries d JOIN outbox o ON o.id=d.outbox_id WHERE d.occurrence_id=? AND d.kind='variation' AND o.dedupe_key=? AND (o.state='pending' OR (o.state='failed' AND d.cancelled=1))").all(o.id,`${episodeKey}:0`)){
          if(row.state==='failed'||row.occurrence_revision!==o.revision)this.repository.event('notification_revalidated',o.id,{outboxId:row.outbox_id,beforeOccurrenceRevision:row.occurrence_revision,afterOccurrenceRevision:o.revision,policyRevision:bill.policy.revision,snapshotId:m.snapshotId},`bill-variation-resumed:${billHash([row.outbox_id,o.revision,m.assignmentRevision,observedKey])}`);
          this.store.db.prepare('UPDATE bill_deliveries SET match_fingerprint=?,occurrence_revision=?,cancelled=0 WHERE outbox_id=?').run(observedKey,o.revision,row.outbox_id);
          this.store.db.prepare("UPDATE outbox SET payload=?,state='pending',available_at=MAX(available_at,?),updated_at=? WHERE id=?").run(JSON.stringify({text:message.text}),this.now(),this.now(),row.outbox_id);
        }
      }
      this.store.db.prepare('INSERT INTO bill_variation_state(occurrence_id,active,episode,observed_key,policy_revision,direction) VALUES(?,?,?,?,?,?) ON CONFLICT(occurrence_id) DO UPDATE SET active=excluded.active,episode=excluded.episode,observed_key=excluded.observed_key,policy_revision=excluded.policy_revision,direction=excluded.direction').run(o.id,active?1:0,episode,observedKey,bill.policy.revision,outcome.direction);
    });
  }
  tick(){
    const revision=this.store.db.prepare('SELECT COUNT(*) n,COALESCE(MAX(rowid),0) last FROM bill_events').get(),signature=`${Math.floor(this.now()/60000)}:${revision.last}:${this.store.getPreference('bill_evidence_revision',0)}:${JSON.stringify(this.service.scope())}`;
    if(signature===this.lastSignature)return [];
    const outputs=[];
    this.service.materialize();
    for(const o of this.repository.occurrences()){
      const bill=this.policy(o);if(!bill){this.store.transaction(()=>this.cancelOld(o,()=>true));continue;}
      const latest=this.slots(o,bill)[0];
      this.store.transaction(()=>{
        this.cancelOld(o,row=>row.occurrence_revision!==o.revision||row.policy_revision!==bill.policy.revision||!bill.active||o.localState!=='open'||(row.kind==='variation'?!bill.policy.variationEnabled:!bill.policy.remindersEnabled||!latest||row.scheduled_at<latest.instant));
        if(latest){const high=this.store.db.prepare("SELECT MAX(scheduled_at) at FROM bill_deliveries WHERE occurrence_id=? AND occurrence_revision=? AND policy_revision=? AND kind IN ('reminder','overdue')").get(o.id,o.revision,bill.policy.revision).at;if(high==null||latest.instant>=high){const key=`bill-reminder:${billHash([o.id,o.revision,bill.policy.revision,latest.stage])}`;if(this.enqueue(o,bill,latest.kind,latest,this.reminderText(o,bill,latest),{key}))outputs.push(o.id);}}
      });
      this.variation(o,bill);
    }
    // Reconciliation is independent from the synchronous local reminder path.
    const active=this.reconciliationEnabled();
    if(active){const instant=Math.floor(this.now()/HOUR)*HOUR,high=Number(this.store.getPreference('bill_reconcile_highwater',-1));if(instant>high)this.store.transaction(()=>{
      this.store.db.prepare("UPDATE jobs SET state='done',updated_at=? WHERE kind='bill_reconcile' AND state='queued'").run(this.now());
      this.store.enqueueJob({kind:'bill_reconcile',payload:{identity:this.store.identity,slot:instant},dedupeKey:`bill-reconcile:${instant}`,priority:-30,safeRetry:true});this.store.setPreference('bill_reconcile_highwater',instant);
    });}else this.store.db.prepare("UPDATE jobs SET state='done',updated_at=? WHERE kind='bill_reconcile' AND state='queued'").run(this.now());
    this.lastSignature=signature;return outputs;
  }
  async runJob(job){
    this.store.assertIdentity(job.payload.identity);if(!this.owns(job))throw new AppError('UNAUTHORIZED');
    if(!this.reconciliationEnabled()){this.store.completeJob(job.id);return;}
    const latest=Math.floor(this.now()/HOUR)*HOUR;if(job.payload.slot<latest){this.store.completeJob(job.id);this.tick();return;}
    try{await this.service.refresh();}
    catch(error){const code=errorCode(error);this.store.transaction(()=>{this.store.completeJob(job.id);this.store.db.prepare('UPDATE jobs SET error_code=? WHERE id=?').run(code,job.id);});return;}
    this.store.completeJob(job.id);this.tick();
  }
  authorizeDelivery(row){
    const d=this.store.db.prepare('SELECT * FROM bill_deliveries WHERE outbox_id=?').get(row.id);if(!d)return true;
    const reject=()=>{this.store.db.prepare("UPDATE bill_deliveries SET cancelled=1 WHERE outbox_id=? AND outbox_id IN (SELECT id FROM outbox WHERE state IN ('pending','sending'))").run(row.id);return false;};
    const o=this.repository.occurrence(d.occurrence_id),bill=this.policy(o);
    if(!bill?.active||o.localState!=='open'||o.revision!==d.occurrence_revision||bill.policy.revision!==d.policy_revision||d.cancelled)return reject();
    if(d.kind==='variation'){
      if(!bill.policy.variationEnabled)return reject();const m=this.freshMatch(o,bill);if(!m)return reject();
      const key=this.observedKey(o,bill,m),state=this.store.db.prepare('SELECT active FROM bill_variation_state WHERE occurrence_id=?').get(o.id);return state?.active===1&&key===d.match_fingerprint?true:reject();
    }
    if(!bill.policy.remindersEnabled)return false;const latest=this.slots(o,bill)[0];if(!latest||latest.instant!==d.scheduled_at)return false;
    // Re-render relative days immediately before send and persist what is sent.
    const text=this.reminderText(o,bill,latest).text;if(text.length>3900)throw new AppError('INPUT_INVALID');
    row.payload={text};this.store.db.prepare("UPDATE outbox SET payload=? WHERE id=? AND state='sending'").run(JSON.stringify(row.payload),row.id);return true;
  }
  prune(days){this.repository.prune(days);}
}
