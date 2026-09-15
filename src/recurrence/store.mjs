import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { splitMessage } from '../storage/store.mjs';
export const billHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json=value=>{const result=JSON.stringify(value);if(Buffer.byteLength(result)>262144)throw new AppError('INPUT_INVALID');return result;};
const parse=row=>row?JSON.parse(row.payload):null;
export const billPolicyHash=config=>billHash({version:'bill-confirmation-1',householdId:config.householdId,budgetId:config.actual.budgetId,serverURL:config.actual.serverURL,userId:config.telegram.userId,chatId:config.telegram.chatId,timezone:config.timezone,currency:config.currency,dryRun:config.dryRun,ttl:900000,origin:'telegram-local-bill'});

export class BillStore {
  constructor(store){this.store=store;this.db=store.db;this.identity=store.identity;}
  context(){return [this.identity.householdId,this.identity.budgetId];}
  units(){return this.db.prepare('SELECT id,name,revision FROM bill_units WHERE household_id=? AND budget_id=? ORDER BY created_at,id').all(...this.context());}
  unit(id){const row=this.units().find(r=>r.id===id);if(!row)throw new AppError('BILL_NOT_FOUND');return row;}
  bills(){return this.db.prepare('SELECT payload FROM recurring_bills WHERE household_id=? AND budget_id=? ORDER BY created_at,id').all(...this.context()).map(parse);}
  bill(id){const row=this.db.prepare('SELECT payload FROM recurring_bills WHERE id=? AND household_id=? AND budget_id=?').get(id,...this.context());if(!row)throw new AppError('BILL_NOT_FOUND');return parse(row);}
  versions(id){this.bill(id);return this.db.prepare('SELECT payload FROM bill_versions WHERE bill_id=? ORDER BY revision').all(id).map(parse);}
  occurrences(){return this.db.prepare('SELECT payload FROM bill_occurrences WHERE household_id=? AND budget_id=? ORDER BY competence,id').all(...this.context()).map(parse);}
  occurrence(id){const row=this.db.prepare('SELECT payload FROM bill_occurrences WHERE id=? AND household_id=? AND budget_id=?').get(id,...this.context());if(!row)throw new AppError('BILL_NOT_FOUND');return parse(row);}
  saveOccurrence(value){
    this.db.prepare(`INSERT INTO bill_occurrences(id,household_id,budget_id,bill_id,competence,revision,local_state,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,local_state=excluded.local_state,payload=excluded.payload,updated_at=excluded.updated_at`).run(value.id,...this.context(),value.billId,value.competence,value.revision,value.localState,json(value),this.store.now(),this.store.now());
  }
  assignments(){return this.db.prepare('SELECT household_id AS householdId,budget_id AS budgetId,transaction_id AS transactionId,unit_id AS unitId,fingerprint,revision FROM bill_assignments WHERE household_id=? AND budget_id=?').all(...this.context());}
  candidates(){return this.db.prepare('SELECT id,state,payload,snapshot_id FROM recurrence_candidates WHERE household_id=? AND budget_id=? ORDER BY id').all(...this.context()).map(r=>({...parse(r),id:r.id,state:r.state,snapshotId:r.snapshot_id}));}
  matches(){return this.db.prepare('SELECT m.payload FROM bill_matches m JOIN bill_occurrences o ON o.id=m.occurrence_id WHERE o.household_id=? AND o.budget_id=?').all(...this.context()).map(parse);}
  match(id){return parse(this.db.prepare('SELECT m.payload FROM bill_matches m JOIN bill_occurrences o ON o.id=m.occurrence_id WHERE m.occurrence_id=? AND o.household_id=? AND o.budget_id=?').get(id,...this.context()));}
  saveCandidates(candidates,snapshotId){for(const c of candidates)this.db.prepare(`INSERT INTO recurrence_candidates(id,household_id,budget_id,state,payload,snapshot_id,updated_at) VALUES(?,?,?,'pending',?,?,?)
    ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,snapshot_id=excluded.snapshot_id,updated_at=excluded.updated_at`).run(c.id,...this.context(),json(c),snapshotId,this.store.now());}
  saveMatch(match){this.db.prepare('INSERT INTO bill_matches(occurrence_id,payload,snapshot_id,observed_at) VALUES(?,?,?,?) ON CONFLICT(occurrence_id) DO UPDATE SET payload=excluded.payload,snapshot_id=excluded.snapshot_id,observed_at=excluded.observed_at').run(match.occurrenceId,json(match),match.snapshotId,match.observedAt??this.store.now());}
  event(kind,entityId,payload,dedupeKey=`audit:${randomUUID()}`){const id=randomUUID();const result=this.db.prepare('INSERT OR IGNORE INTO bill_events(id,household_id,budget_id,kind,entity_id,dedupe_key,payload,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,...this.context(),kind,entityId,dedupeKey,json(payload),this.store.now());return result.changes?id:null;}
  assertJob(job,identity){this.store.assertIdentity(identity);const row=this.db.prepare("SELECT payload FROM jobs WHERE id=? AND household_id=? AND state='running'").get(job?.id??'',identity.householdId);if(!row?.payload)throw new AppError('STORAGE_FAILED');this.store.assertIdentity(JSON.parse(row.payload).identity??{});}
  decodeProposal(row,identity){this.store.assertIdentity(identity);if(!row||row.household_id!==identity.householdId||row.budget_id!==identity.budgetId||row.user_id!==identity.userId||row.chat_id!==identity.chatId)throw new AppError('UNAUTHORIZED');return {...row,input:row.payload?JSON.parse(row.payload):null,result:row.result_json?JSON.parse(row.result_json):null};}
  fromSource(job,identity){this.assertJob(job,identity);const row=this.db.prepare('SELECT * FROM bill_proposals WHERE source_job_id=?').get(job.id);return row?this.decodeProposal(row,identity):null;}
  proposal(nonce,identity){return this.decodeProposal(this.db.prepare('SELECT * FROM bill_proposals WHERE nonce=?').get(nonce),identity);}
  propose(kind,input,{job,identity,config}){return this.store.transaction(()=>{const replay=this.fromSource(job,identity);if(replay)return replay;const id=randomUUID(),nonce=randomBytes(18).toString('base64url');
    this.db.prepare("INSERT INTO bill_proposals(id,nonce,source_job_id,household_id,budget_id,user_id,chat_id,kind,state,policy_hash,payload,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?,?)").run(id,nonce,job.id,...this.context(),identity.userId,identity.chatId,kind,billPolicyHash(config),json(input),this.store.now(),this.store.now()+900000);
    this.event('proposal_created',id,{kind,policyHash:billPolicyHash(config)});return this.proposal(nonce,identity);
  });}
  confirm(nonce,{job,identity,config,apply,render}){return this.store.transaction(()=>{
    this.assertJob(job,identity);const p=this.proposal(nonce,identity);
    if(p.state==='confirmed'&&p.confirmation_job_id===job.id&&p.result)return p.result;
    if(p.state!=='pending')throw new AppError('PROPOSAL_USED');if(p.expires_at<=this.store.now()||!p.input)throw new AppError('PROPOSAL_EXPIRED');if(p.policy_hash!==billPolicyHash(config))throw new AppError('PROPOSAL_POLICY_CHANGED');
    const outcome=apply(p),message={...render(outcome,p),dedupeKey:`bill-confirmed:${p.id}`};
    this.db.prepare("UPDATE bill_proposals SET state='confirmed',consumed_at=?,confirmation_job_id=?,result_json=? WHERE id=?").run(this.store.now(),job.id,json(message),p.id);
    this.event('confirmed',p.id,{kind:p.kind,before:p.input.before??null,after:outcome,policyHash:p.policy_hash},`confirmed:${p.id}`);
    splitMessage(message.text).forEach((text,i)=>this.store.enqueueOutbox({text,dedupeKey:`${message.dedupeKey}:${i}`}));return message;
  });}
  cancelProposal(nonce,identity){return this.store.transaction(()=>{const p=this.proposal(nonce,identity);if(p.state!=='pending')throw new AppError('PROPOSAL_USED');this.db.prepare("UPDATE bill_proposals SET state='cancelled',consumed_at=? WHERE id=?").run(this.store.now(),p.id);this.event('proposal_cancelled',p.id,{});});}
  invalidateDeliveries(occurrenceId){this.db.prepare("UPDATE bill_deliveries SET cancelled=1 WHERE occurrence_id=? AND outbox_id IN (SELECT id FROM outbox WHERE state='pending')").run(occurrenceId);this.db.prepare("UPDATE outbox SET state='failed',updated_at=? WHERE state='pending' AND id IN (SELECT outbox_id FROM bill_deliveries WHERE occurrence_id=? AND cancelled=1)").run(this.store.now(),occurrenceId);}
  prune(days){const cutoff=this.store.now()-days*86400000;this.store.transaction(()=>{
    this.db.prepare("UPDATE bill_proposals SET payload=NULL,result_json=NULL WHERE created_at<? AND (state<>'pending' OR expires_at<=?)").run(cutoff,this.store.now());
    this.db.prepare('UPDATE bill_events SET payload=NULL WHERE created_at<?').run(cutoff);
    this.db.prepare("UPDATE outbox SET payload=NULL WHERE state IN ('sent','failed','uncertain') AND updated_at<? AND id IN (SELECT outbox_id FROM bill_deliveries)").run(cutoff);
    this.db.prepare('UPDATE recurrence_candidates SET payload=NULL WHERE updated_at<?').run(cutoff);
    this.db.prepare('DELETE FROM bill_matches WHERE observed_at<?').run(cutoff);
  });}
}
