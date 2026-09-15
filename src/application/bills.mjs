import { randomUUID } from 'node:crypto';
import { AppError,errorCode } from '../errors.mjs';
import { identityFromConfig } from '../policy/authorize.mjs';
import { localToday,calendarMonths } from '../finance/periods.mjs';
import { DEFAULT_SCOPE,validateScope } from '../finance/analyze.mjs';
import { validDate } from '../actual/snapshot.mjs';
import { label } from '../reports/render.mjs';
import { withActionMetadata } from '../categorization/response.mjs';
import { BillStore,billHash,billPolicyHash } from '../recurrence/store.mjs';
import { defaultBillPolicy,validateBillPolicy } from '../recurrence/preferences.mjs';
import { buildCalendar,validateRecurrenceBill,deriveOccurrenceState } from '../recurrence/calendar.mjs';
import { detectCandidates,recurrenceTransactionFingerprint } from '../recurrence/detect.mjs';
import { matchOccurrences } from '../recurrence/match.mjs';
import { parseBillCommand,renderBillProposal,billDetails,amountText,BILL_HELP,SCHEDULE_ADAPTATION } from '../telegram/bills.mjs';

const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const id=value=>{if(!validId(value))throw new AppError('INPUT_INVALID');return value;};
const month=value=>{if(typeof value!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)||!validDate(value+'-01'))throw new AppError('INPUT_INVALID');return value;};
const addMonths=(value,n)=>{const date=new Date(`${value}-01T12:00:00Z`);date.setUTCMonth(date.getUTCMonth()+n);return date.toISOString().slice(0,7);};
const integer=value=>{if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))throw new AppError('INPUT_INVALID');return Number(value);};
const bool=value=>{if(!['sim','nao'].includes(value))throw new AppError('INPUT_INVALID');return value==='sim';};
const named=(fields,allowed,required=[])=>{if(Object.keys(fields).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(fields,k)))throw new AppError('INPUT_INVALID');};
const name=value=>{if(typeof value!=='string'||!value.trim()||value.length>80||/[\u0000-\u001f\u007f]/.test(value))throw new AppError('INPUT_INVALID');return value.trim();};
const reference=value=>value==='desconhecido'?null:(()=>{const n=integer(value);if(n<1)throw new AppError('INPUT_INVALID');return n;})();
const kind=value=>{if(!['confirmado','estimado'].includes(value))throw new AppError('INPUT_INVALID');return value==='confirmado'?'confirmed':'estimated';};
const commands=new Set(['/unidades','/unidade','/recorrencias','/recorrencia','/proximos_vencimentos','/ocorrencia','/pago','/reabrir','/cancelar_ocorrencia']);

export class BillService {
  constructor({config,store,actual,now=()=>new Date()}){Object.assign(this,{config,store,actual,now});this.identity=identityFromConfig(config);this.repository=new BillStore(store);}
  today(){return localToday(this.config.timezone,this.now());}
  scope(){return validateScope(this.store.getPreference('finance_scope',DEFAULT_SCOPE));}
  async snapshot(){const period=calendarMonths(12,this.today()),s=await this.actual.snapshot(period);if(['householdId','budgetId','timezone','currency'].some(k=>s?.[k]!==this.identity[k]))throw new AppError('UNAUTHORIZED');if(s.period?.start!==period.start||s.period?.end!==period.end||s.coverage?.complete!==true||s.coverage.failedAccountIds?.length!==0||s.rulesVersion!=='1'||s.transactionMetadataVersion!=='1')throw new AppError('SNAPSHOT_INVALID');for(const row of s.transactions)recurrenceTransactionFingerprint(this.identity,row);return s;}
  localBills(){return this.repository.bills();}
  effectiveBill(billId,competence){const b=this.repository.versions(billId).filter(v=>v.effectiveFrom<=competence).sort((a,b)=>b.revision-a.revision)[0]?.bill;return b&&b.startCompetence<=competence&&(!b.endCompetence||competence<=b.endCompetence)?b:null;}
  knownBills(){
    const unique=new Map(),today=this.today(),period=calendarMonths(12,today),start=new Date(Date.parse(period.start+'T12:00:00Z')-7*86400000).toISOString().slice(0,10),end=new Date(Date.parse(today+'T12:00:00Z')+7*86400000).toISOString().slice(0,10),occurrences=this.repository.occurrences();
    for(const bill of this.localBills())for(const version of this.repository.versions(bill.id)){
      const visibleFuture=version.effectiveFrom>today.slice(0,7)&&occurrences.some(o=>o.billId===bill.id&&o.localState!=='cancelled'&&o.dueDate>=start&&o.dueDate<=end&&this.effectiveBill(o.billId,o.competence)?.revision===version.revision);
      if(version.bill.active&&(version.effectiveFrom<=today.slice(0,7)||visibleFuture)){const b=version.bill;unique.set(JSON.stringify([b.unitId,b.payeeId,b.accountId,b.sourceScheduleId]),b);}
    }return [...unique.values()];
  }
  mappingSignature(bills=this.knownBills()){return billHash(bills.map(b=>JSON.stringify([b.unitId,b.payeeId,b.accountId,b.sourceScheduleId])).sort());}
  competitionSignature(o){return billHash(this.repository.occurrences().filter(c=>c.localState!=='cancelled'&&(c.localState!=='open'||this.effectiveBill(c.billId,c.competence)?.active)&&c.unitId===o.unitId&&c.payeeId===o.payeeId&&c.accountId===o.accountId&&Math.abs(Date.parse(c.dueDate+'T12:00:00Z')-Date.parse(o.dueDate+'T12:00:00Z'))<=14*86400000).map(c=>JSON.stringify([c.id,c.dueDate,c.unitId,c.payeeId,c.accountId])).sort());}
  currentEvidence(m,o){return m?.dataState==='fresh'&&m.occurrenceRevision===o.revision&&JSON.stringify(m.scope)===JSON.stringify(this.scope())&&m.assignmentRevision===this.store.getPreference('bill_assignment_revision',0)&&m.mappingSignature===this.mappingSignature()&&m.competitionSignature===this.competitionSignature(o);}
  invalidateEvidence(predicate=()=>true){let changed=false;for(const m of this.repository.matches())if(predicate(m)){changed=true;this.repository.saveMatch({...m,dataState:'stale'});this.store.db.prepare("UPDATE bill_deliveries SET cancelled=1 WHERE occurrence_id=? AND kind='variation' AND outbox_id IN (SELECT id FROM outbox WHERE state='pending')").run(m.occurrenceId);this.store.db.prepare("UPDATE outbox SET state='failed',updated_at=? WHERE state='pending' AND id IN (SELECT outbox_id FROM bill_deliveries WHERE occurrence_id=? AND kind='variation' AND cancelled=1)").run(this.store.now(),m.occurrenceId);}if(changed)this.store.setPreference('bill_evidence_revision',this.store.getPreference('bill_evidence_revision',0)+1);}
  materializeEvidenceWindow(period=calendarMonths(12,this.today())){const endMonth=new Date(Date.parse(period.end+'T12:00:00Z')+7*86400000).toISOString().slice(0,7);for(let from=addMonths(period.start.slice(0,7),-2);from<=endMonth;from=addMonths(from,12))this.materialize(from,addMonths(from,11)<endMonth?addMonths(from,11):endMonth);}
  materialize(from=addMonths(this.today().slice(0,7),-1),to=addMonths(this.today().slice(0,7),10)){
    month(from);month(to);if(from>to)throw new AppError('INPUT_INVALID');
    return this.store.transaction(()=>{
      for(const bill of this.localBills()){
        const versions=this.repository.versions(bill.id);
        for(const version of versions){
          const later=versions.filter(v=>v.revision>version.revision&&v.effectiveFrom<=to);
          const result=buildCalendar([{...version.bill,active:true}],{identity:this.identity,from,to,today:this.today(),timezone:this.config.timezone});
          for(const row of result.occurrences){
            if(row.competence<version.effectiveFrom||later.some(v=>v.effectiveFrom<=row.competence))continue;
            const existing=this.store.db.prepare('SELECT payload FROM bill_occurrences WHERE id=?').get(row.id);
            const old=existing?JSON.parse(existing.payload):null;
            if(old&&(old.localState!=='open'||old.override||old.billRevision>=version.bill.revision))continue;
            const value={...row,localState:'open',revision:old?old.revision+1:1,paidAt:null,confirmedAt:null,override:false};
            if(old)this.repository.invalidateDeliveries(old.id);this.repository.saveOccurrence(value);
          }
        }
      }
      return this.repository.occurrences();
    });
  }
  async refresh(){
    this.materialize();let snapshot;
    try{snapshot=await this.snapshot();}catch(error){this.store.transaction(()=>{for(const match of this.repository.matches())this.repository.saveMatch({...match,dataState:'stale'});});throw error;}
    // Materialize every possible competitor, regardless of prior calendar views.
    // Include the preceding due month plus offset=1, and the trailing 7-day edge.
    this.materializeEvidenceWindow(snapshot.period);
    const txIds=new Set(snapshot.transactions.map(t=>t.id)),assignments=this.repository.assignments().filter(a=>txIds.has(a.transactionId)),knownBills=this.knownBills(),options={identity:this.identity,today:this.today(),period:snapshot.period,scope:this.scope(),unitAssignments:assignments,knownBills};
    const batch=this.repository.occurrences().filter(o=>(o.localState!=='open'||this.effectiveBill(o.billId,o.competence)?.active)&&o.dueDate>=new Date(Date.parse(snapshot.period.start+'T12:00:00Z')-7*86400000).toISOString().slice(0,10)&&o.dueDate<=new Date(Date.parse(snapshot.period.end+'T12:00:00Z')+7*86400000).toISOString().slice(0,10)),ids=new Set(batch.map(o=>o.id));
    let detected,matched;
    try{detected=detectCandidates(snapshot,options);matched=matchOccurrences(batch,snapshot,{...options,dateWindowDays:7,previousMatches:this.repository.matches().filter(m=>ids.has(m.occurrenceId)),dataState:'fresh'});}
    catch(error){this.store.transaction(()=>{for(const match of this.repository.matches())this.repository.saveMatch({...match,dataState:'stale'});});throw error;}
    this.store.transaction(()=>{this.repository.saveCandidates(detected.candidates,snapshot.id);for(const match of matched.matches)this.repository.saveMatch({...match,dataState:'fresh',observedAt:this.store.now(),scope:options.scope,occurrenceRevision:batch.find(o=>o.id===match.occurrenceId).revision,assignmentRevision:this.store.getPreference('bill_assignment_revision',0),mappingSignature:this.mappingSignature(knownBills),competitionSignature:this.competitionSignature(batch.find(o=>o.id===match.occurrenceId))});for(const revoked of matched.revokedEvidence)this.repository.event('evidence_revoked',revoked.occurrenceId,{...revoked,snapshotId:snapshot.id});this.store.setPreference('bill_evidence_revision',this.store.getPreference('bill_evidence_revision',0)+1);});
    return {snapshot,detected,matched};
  }
  async schedules(){const result=await this.actual.readSchedules();if(['householdId','budgetId','timezone','currency'].some(k=>result?.[k]!==this.identity[k]))throw new AppError('UNAUTHORIZED');if(result.rulesVersion!=='schedules-1'||result.coverage?.complete!==true||!Array.isArray(result.schedules))throw new AppError('SNAPSHOT_INVALID');return result;}
  policy(fields,old=defaultBillPolicy(this.config.timezone)){
    const p={...old,days:[...old.days]};
    if('lembretes'in fields)p.remindersEnabled=bool(fields.lembretes);if('dias'in fields)p.days=fields.dias.split(',').map(integer);if('horario'in fields)p.time=fields.horario;
    if('variacao'in fields)p.variationEnabled=bool(fields.variacao);if('percentual'in fields)p.variationPercent=integer(fields.percentual);if('minimo_centavos'in fields)p.variationMinimumCents=integer(fields.minimo_centavos);
    return validateBillPolicy(p,this.config.timezone);
  }
  billFields(fields,before=null){
    const keys=['nome','unidade','favorecido','conta','inicio','fim','dia','mes_offset','tipo_data','valor_centavos','lembretes','dias','horario','variacao','percentual','minimo_centavos','ativa','a_partir','candidato','agendamento'];
    named(fields,keys,before?['a_partir']:['nome','unidade','favorecido','conta','inicio','dia','mes_offset','tipo_data','valor_centavos']);
    if(before&&('inicio'in fields||'candidato'in fields||'agendamento'in fields))throw new AppError('INPUT_INVALID');
    const b=before?structuredClone(before):{id:randomUUID(),householdId:this.identity.householdId,budgetId:this.identity.budgetId,source:'manual',sourceScheduleId:null,endCompetence:null,active:true,revision:1};
    for(const [key,field] of [['nome','name'],['unidade','unitId'],['favorecido','payeeId'],['conta','accountId'],['inicio','startCompetence']])if(key in fields)b[field]=key==='nome'?name(fields[key]):key==='inicio'?month(fields[key]):id(fields[key]);
    if('fim'in fields)b.endCompetence=fields.fim==='sem_fim'?null:month(fields.fim);if('dia'in fields)b.dueDay=integer(fields.dia);if('mes_offset'in fields)b.monthOffset=integer(fields.mes_offset);if('tipo_data'in fields){b.dateKind=kind(fields.tipo_data);b.dateSource=b.dateKind==='confirmed'?'user_confirmed':'user_estimate';}
    if('valor_centavos'in fields)b.referenceAmountCents=reference(fields.valor_centavos);if('ativa'in fields)b.active=bool(fields.ativa);
    b.policy=this.policy(fields,before?.policy);if(before)b.revision++;
    validateRecurrenceBill(b,this.identity);this.repository.unit(b.unitId);return b;
  }
  async prepareBill(fields,before,ctx){
    const bill=this.billFields(fields,before),effectiveFrom=before?month(fields.a_partir):bill.startCompetence;
    if(before&&effectiveFrom<this.today().slice(0,7))throw new AppError('INPUT_INVALID');
    if(!before&&bill.startCompetence<addMonths(this.today().slice(0,7),-11))throw new AppError('INPUT_INVALID');
    let source=null;
    const snapshot=!before||before.accountId!==bill.accountId||before.payeeId!==bill.payeeId?await this.snapshot():null,account=snapshot?snapshot.accounts.find(a=>a.id===bill.accountId):{id:bill.accountId,name:bill.accountId},payee=snapshot?snapshot.payees.find(p=>p.id===bill.payeeId):{id:bill.payeeId,name:bill.payeeId};
    if(!account||!payee||payee.transferAccountId)throw new AppError('BILL_EVIDENCE_STALE');
    if(fields.candidato){const fresh=await this.refresh(),c=fresh.detected.candidates.find(c=>c.id===id(fields.candidato));if(!c||this.repository.candidates().find(r=>r.id===c.id)?.state!=='pending'||c.unitId!==bill.unitId||c.payeeId!==bill.payeeId||c.accountId!==bill.accountId)throw new AppError('BILL_EVIDENCE_STALE');bill.source='history';source={kind:'candidate',id:c.id,hash:billHash(c.evidence)};}
    if(fields.agendamento){if(source)throw new AppError('INPUT_INVALID');const s=(await this.schedules()).schedules.find(s=>s.id===id(fields.agendamento));if(!s||s.accountId!==bill.accountId||s.payeeId!==bill.payeeId)throw new AppError('BILL_EVIDENCE_STALE');bill.source='actual';bill.sourceScheduleId=s.id;source={kind:'schedule',id:s.id,hash:s.fingerprint};}
    const affected=this.repository.occurrences().filter(o=>o.billId===bill.id&&o.competence>=effectiveFrom&&o.localState==='open'&&!o.override).length;
    const preview=`${before?'Editar cadastro: antes\n'+billDetails(before,this.repository.unit(before.unitId).name)+'\nDEPOIS\n':'Cadastrar recorrência\n'}${billDetails(bill,this.repository.unit(bill.unitId).name)}\nFavorecido ${label(payee.name)}; conta ${label(account.name)}.\nAplicar desde competência ${effectiveFrom}; ${affected} ocorrências abertas já materializadas afetadas. Pagas/canceladas e alterações específicas preservadas. Avisos ativados começam após esta confirmação, sem etapas anteriores à inscrição.`;
    return this.repository.propose(before?'edit_bill':'create_bill',{before,after:bill,effectiveFrom,source,preview},ctx);
  }
  async prepareAssignment(fields,ctx){
    named(fields,['unidade','lancamentos'],['unidade','lancamentos']);const unit=this.repository.unit(id(fields.unidade)),ids=fields.lancamentos.split(',').map(id);if(!ids.length||ids.length>30||new Set(ids).size!==ids.length)throw new AppError('INPUT_INVALID');
    const s=await this.snapshot(),existing=this.repository.assignments(),rows=ids.map(txId=>{const row=s.transactions.find(r=>r.id===txId);if(!row)throw new AppError('BILL_EVIDENCE_STALE');return {householdId:this.identity.householdId,budgetId:this.identity.budgetId,transactionId:txId,unitId:unit.id,fingerprint:recurrenceTransactionFingerprint(this.identity,row),revision:(existing.find(a=>a.transactionId===txId)?.revision??0)+1};});
    const details=ids.map(txId=>{const tx=s.transactions.find(t=>t.id===txId),old=existing.find(a=>a.transactionId===txId);return `${txId}: ${tx.date}, ${amountText(tx.amount)}, conta ${label(s.accounts.find(a=>a.id===tx.accountId)?.name??tx.accountId)} (${tx.accountId}), favorecido ${label(s.payees.find(p=>p.id===tx.payeeId)?.name??tx.payeeId)} (${tx.payeeId??'ausente'}); unidade ${old?label(this.repository.unit(old.unitId).name)+' ('+old.unitId+')':'não atribuída'} → ${label(unit.name)} (${unit.id}).`;}).join('\n');
    return this.repository.propose('assign',{before:existing.filter(a=>ids.includes(a.transactionId)),after:rows,preview:`Atribuir ${ids.length} lançamentos à unidade ${label(unit.name)} (${unit.id}):\n${details}\nSomente evidência local; IDs e fingerprints serão conferidos novamente antes da confirmação. Não confirma recorrência nem pagamento.`},ctx);
  }
  applyProposal(p){
    const x=p.input,r=this.repository,db=this.store.db,now=this.store.now();
    if(p.kind==='unit'){if(r.units().length>=100)throw new AppError('INPUT_INVALID');db.prepare('INSERT INTO bill_units(id,household_id,budget_id,name,revision,created_at) VALUES(?,?,?,?,1,?)').run(x.after.id,...r.context(),x.after.name,now);return x.after;}
    if(p.kind==='create_bill'||p.kind==='edit_bill'){
      if(p.kind==='edit_bill'&&billHash(r.bill(x.before.id))!==billHash(x.before))throw new AppError('BILL_CONFLICT');if(p.kind==='create_bill'&&r.bills().length>=100)throw new AppError('INPUT_INVALID');
      const mappingBefore=this.mappingSignature(),b=structuredClone(x.after);r.unit(b.unitId);b.policy={...b.policy,revision:(x.before?.policy.revision??0)+1,since:now};
      db.prepare('INSERT INTO recurring_bills(id,household_id,budget_id,unit_id,revision,active,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET unit_id=excluded.unit_id,revision=excluded.revision,active=excluded.active,payload=excluded.payload,updated_at=excluded.updated_at').run(b.id,...r.context(),b.unitId,b.revision,b.active?1:0,JSON.stringify(b),now,now);
      db.prepare('INSERT INTO bill_versions(bill_id,revision,effective_from,payload,created_at) VALUES(?,?,?,?,?)').run(b.id,b.revision,x.effectiveFrom,JSON.stringify({bill:b,effectiveFrom:x.effectiveFrom,revision:b.revision}),now);
      for(const o of r.occurrences().filter(o=>o.billId===b.id&&o.competence>=x.effectiveFrom))r.invalidateDeliveries(o.id);
      if(x.source?.kind==='candidate')db.prepare("UPDATE recurrence_candidates SET state='accepted' WHERE id=? AND state='pending'").run(x.source.id);
      this.materialize();this.materializeEvidenceWindow();if(mappingBefore!==this.mappingSignature())this.invalidateEvidence();else this.invalidateEvidence(m=>!this.currentEvidence(m,r.occurrence(m.occurrenceId)));return b;
    }
    if(p.kind==='assign'){
      const current=r.assignments().filter(a=>x.after.some(b=>b.transactionId===a.transactionId));if(billHash(current)!==billHash(x.before))throw new AppError('BILL_CONFLICT');
      for(const a of x.after){r.unit(a.unitId);db.prepare('INSERT INTO bill_assignments(household_id,budget_id,transaction_id,unit_id,fingerprint,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(household_id,budget_id,transaction_id) DO UPDATE SET unit_id=excluded.unit_id,fingerprint=excluded.fingerprint,revision=excluded.revision,updated_at=excluded.updated_at').run(...r.context(),a.transactionId,a.unitId,a.fingerprint,a.revision,now,now);}this.store.setPreference('bill_assignment_revision',this.store.getPreference('bill_assignment_revision',0)+1);this.invalidateEvidence();return {assigned:x.after.map(a=>a.transactionId),unitId:x.after[0].unitId};
    }
    if(p.kind==='reject'){
      const row=r.candidates().find(c=>c.id===x.after.id);if(!row||row.state!=='pending')throw new AppError('BILL_CONFLICT');db.prepare("UPDATE recurrence_candidates SET state='rejected' WHERE id=?").run(row.id);return {id:row.id,state:'rejected'};
    }
    if(p.kind==='occurrence'){
      const old=r.occurrence(x.before.id);if(billHash(old)!==billHash(x.before))throw new AppError('BILL_CONFLICT');
      const after={...x.after,revision:old.revision+1,confirmedAt:x.after.localState==='paid_manual'?new Date(now).toISOString():null};r.saveOccurrence(after);r.invalidateDeliveries(old.id);this.invalidateEvidence(m=>!this.currentEvidence(m,r.occurrence(m.occurrenceId)));return after;
    }
    throw new AppError('INPUT_INVALID');
  }
  async confirm(nonce,ctx){
    const p=this.repository.proposal(nonce,ctx.identity);
    if(p.state==='pending'){
      if(p.expires_at<=this.store.now()||!p.input)throw new AppError('PROPOSAL_EXPIRED');
      if(p.policy_hash!==billPolicyHash(this.config))throw new AppError('PROPOSAL_POLICY_CHANGED');
      if(p.kind==='assign'){const s=await this.snapshot();for(const a of p.input.after){const row=s.transactions.find(r=>r.id===a.transactionId);if(!row||recurrenceTransactionFingerprint(this.identity,row)!==a.fingerprint)throw new AppError('BILL_EVIDENCE_STALE');}}
      if(p.input?.source?.kind==='candidate'){const fresh=await this.refresh(),c=fresh.detected.candidates.find(c=>c.id===p.input.source.id);if(!c||this.repository.candidates().find(r=>r.id===c.id)?.state!=='pending'||billHash(c.evidence)!==p.input.source.hash)throw new AppError('BILL_EVIDENCE_STALE');}
      if(p.input?.source?.kind==='schedule'){const s=(await this.schedules()).schedules.find(s=>s.id===p.input.source.id);if(!s||s.fingerprint!==p.input.source.hash)throw new AppError('BILL_EVIDENCE_STALE');}
    }
    return this.repository.confirm(nonce,{...ctx,apply:p=>this.applyProposal(p),render:(outcome,p)=>withActionMetadata({text:`Alteração LOCAL confirmada. Registro ${outcome.id??p.id}. ${p.kind==='occurrence'?`Estado local: ${outcome.localState}; data de pagamento informada: ${outcome.paidAt??'não informada'}; confirmação: ${outcome.confirmedAt??'não se aplica'}.`:p.kind==='assign'?`${outcome.assigned.length} atribuições registradas.`:p.kind==='reject'?'Candidato rejeitado; novas evidências não o reativam automaticamente.':'Cadastro persistido.'}\nNenhuma escrita no Actual, pagamento bancário ou validação de documento foi executado.`},{reason:'bill_command'})});
  }
  getUpcoming({from=this.today(),to=new Date(Date.parse(this.today()+'T12:00:00Z')+7*86400000).toISOString().slice(0,10)}={}){
    if(!validDate(from)||!validDate(to)||from>to)throw new AppError('INPUT_INVALID');this.materialize(addMonths(from.slice(0,7),-1),to.slice(0,7));
    const bills=this.localBills();return {available:true,registeredCount:bills.length,items:this.repository.occurrences().filter(o=>this.effectiveBill(o.billId,o.competence)?.active&&o.localState==='open'&&o.dueDate>=from&&o.dueDate<=to).map(o=>({id:o.id,name:`${o.name} (${this.repository.unit(o.unitId).name})`,dueDate:o.dueDate,dateKind:o.dateKind,amountCents:o.expectedAmountCents}))};
  }
  occurrenceText(o){
    const match=this.repository.match(o.id),fresh=this.currentEvidence(match,o);
    const scheduled=this.effectiveBill(o.billId,o.competence)?.active,state=deriveOccurrenceState(o,{today:this.today(),matchState:fresh?match.state:'unknown'}),labels={cancelled:'cancelado localmente',paid_manual:'pagamento confirmado manualmente',overdue:'vencimento confirmado ultrapassado; pagamento não confirmado',compatible:'lançamento compatível; pagamento não confirmado',planned:'planejado'};
    const evidenceNames={compatible:'compatível',ambiguous:'ambígua',none:'sem lançamento compatível',unknown:'não determinada'};
    return `${label(o.name)} — ${o.id}\nUnidade ${label(this.repository.unit(o.unitId).name)} (${o.unitId}); competência ${o.competence}; vencimento ${o.dueDate} (${o.dateKind==='confirmed'?'confirmado':'estimado'})${o.adjusted?'; ajustado para último dia do mês':''}.\nValor esperado ${amountText(o.expectedAmountCents)}. Estado: ${o.localState==='open'&&!scheduled?'fora da agenda atual por pausa/fim/vigência; registro preservado':labels[state.state]}${scheduled&&state.estimatedDatePassed?'; data estimada ultrapassada':''}.\nPagamento manual: ${o.localState==='paid_manual'?`confirmado; data informada ${o.paidAt??'não informada'}; registrado ${o.confirmedAt}`:'não confirmado'}. Documento: chegada não verificada.\n${match?`Evidência ${evidenceNames[match.state]}; ${match.evidence?.length??0} lançamento(s), snapshot ${label(match.snapshotId)}, sync ${label(match.syncedAt)}; ${fresh?'observação da última leitura neste escopo':'observação desatualizada ou de outra revisão/escopo'}. Não comprova pagamento.\n${(match.evidence??[]).slice(0,5).map(e=>`${e.transactionId}: ${e.date}, despesa ${amountText(e.amountCents)}.`).join('\n')}${match.evidence?.length>5?'\nPrimeiras 5 evidências; consulte o Actual para todas.':''}`:'Sem observação de lançamento compatível.'}`;
  }
  async handle(request,job){
    this.store.assertIdentity(request.identity);const began=performance.now();let parsed;
    if(request.type==='callback'){const m=/^(rf|rx):([A-Za-z0-9_-]{24})$/.exec(request.data);if(!m)return null;parsed={words:['/recorrencia',m[1]==='rf'?'confirmar':'cancelar_proposta',m[2]],fields:{}};}
    else{const command=request.text.trim().split(/\s+/)[0].toLowerCase();if(!commands.has(command))return null;parsed=parseBillCommand(request.text);}
    const result=await this.dispatch(parsed,{job,identity:request.identity,config:this.config});return withActionMetadata(result,{reason:'bill_command',durationMs:Math.max(0,Math.round(performance.now()-began))});
  }
  async dispatch({words,fields},ctx){
    const [raw,...args]=words,command=raw.toLowerCase(),r=this.repository;
    if(command==='/unidades'){named(fields,[]);if(args.length)throw new AppError('INPUT_INVALID');return {text:r.units().map(u=>`${u.id}: ${label(u.name)}`).join('\n')||'Nenhuma unidade. /unidade cadastrar nome="Apartamento"'};}
    if(command==='/unidade'){if(args.join(' ')!=='cadastrar')throw new AppError('INPUT_INVALID');named(fields,['nome'],['nome']);return renderBillProposal(r.propose('unit',{after:{id:randomUUID(),name:name(fields.nome)},preview:`Criar unidade local ${label(name(fields.nome))}; nenhum identificador real de instalação é necessário.`},ctx));}
    if(command==='/recorrencias'){
      if(args.length>2)throw new AppError('INPUT_INVALID');named(fields,[]);const action=args[0]??'listar',page=args[1]?integer(args[1]):1;if(page<1)throw new AppError('INPUT_INVALID');
      let rows;
      if(action==='atualizar'){const out=await this.refresh();return {text:`Leitura nova: ${out.detected.candidates.length} candidatos, ${out.matched.matches.length} ocorrências confrontadas; ${out.detected.unresolvedEvidence.length} evidências sem unidade resolvida. Pagamento não é inferido.`};}
      if(action==='candidatos'){const fresh=await this.refresh(),current=new Set(fresh.detected.candidates.map(c=>c.id));rows=r.candidates().map(c=>`${c.id} [${c.state}${c.state==='pending'&&!current.has(c.id)?'; suporte não confirmado na leitura atual':''}] unidade ${c.unitId??'desconhecida'}, favorecido ${c.payeeId??'não informado'}, conta ${c.accountId??'não informada'}; meses ${(c.months??[]).join(',')}; referência sugerida ${amountText(c.suggestedAmountCents)}.`);}
      else if(action==='pendencias'){
        const fresh=await this.refresh();rows=fresh.detected.unresolvedEvidence.map(e=>{
          const entries=e.transactionIds.map(txId=>{const tx=fresh.snapshot.transactions.find(t=>t.id===txId);return tx?`${tx.id}: ${tx.date}, ${amountText(tx.amount)}; favorecido ${label(fresh.snapshot.payees.find(p=>p.id===tx.payeeId)?.name??tx.payeeId)} (${tx.payeeId??'ausente'}); conta ${label(fresh.snapshot.accounts.find(a=>a.id===tx.accountId)?.name??tx.accountId)} (${tx.accountId}).`:null;}).filter(Boolean);
          return `Revisão necessária (${e.reason}).\n${entries.join('\n')}\nEscolha a unidade em /unidades; /recorrencia atribuir unidade=ID lancamentos=${e.transactionIds.join(',')}`;
        });
      }
      else if(action==='favorecidos'){rows=(await this.snapshot()).payees.map(p=>`${p.id}: ${label(p.name)}${p.transferAccountId?' (transferência)':''}`);}
      else if(action==='agendamentos'){rows=(await this.schedules()).schedules.map(s=>`${s.id}: ${label(s.name)}; favorecido ${s.payeeId??'ausente'}; conta ${s.accountId??'ausente'}; próxima data Actual ${s.nextDate??'ausente'}; regra ${label(JSON.stringify(s.date),250)}; valor ${s.amountCents==null?'intervalo/ausente':amountText(s.amountCents)} (${s.amountOp}); completed=${s.completed}. ${SCHEDULE_ADAPTATION} Sem comprovar pagamento ou ativar cadastro local.`);}
      else if(action==='listar'){rows=r.bills().map(b=>{const current=this.effectiveBill(b.id,this.today().slice(0,7)),future=r.versions(b.id).filter(v=>v.effectiveFrom>this.today().slice(0,7));return `${current?'Versão vigente neste mês:\n'+billDetails(current,r.unit(current.unitId).name):'Ainda sem versão vigente.'}${future.map(v=>`\nVERSÃO PROGRAMADA desde ${v.effectiveFrom}:\n${billDetails(v.bill,r.unit(v.bill.unitId).name)}`).join('\n')}`;});}
      else return {text:BILL_HELP};
      const pages=Math.max(1,Math.ceil(rows.length/5));if(page>pages)throw new AppError('INPUT_INVALID');return {text:`Recorrências — ${action}, página ${page}/${pages}.\n${rows.slice((page-1)*5,page*5).join('\n\n')||'Nenhum registro.'}${page<pages?`\n/recorrencias ${action} ${page+1}`:''}\n${rows.length?'':BILL_HELP}`};
    }
    if(command==='/recorrencia'){
      const [action,target]=args;if(args.length>2)throw new AppError('INPUT_INVALID');
      if(action==='confirmar'||action==='cancelar_proposta'){named(fields,[]);if(!/^[A-Za-z0-9_-]{24}$/.test(target??''))throw new AppError('INPUT_INVALID');if(action==='confirmar')return this.confirm(target,ctx);r.cancelProposal(target,ctx.identity);return {text:'Proposta local cancelada.'};}
      const replay=r.fromSource(ctx.job,ctx.identity);if(replay)return renderBillProposal(replay);
      if(action==='cadastrar'&&!target)return renderBillProposal(await this.prepareBill(fields,null,ctx));
      if(action==='editar'&&target)return renderBillProposal(await this.prepareBill(fields,r.bill(id(target)),ctx));
      if(action==='pausar'&&target){named(fields,[]);return renderBillProposal(await this.prepareBill({a_partir:this.today().slice(0,7),ativa:'nao'},r.bill(id(target)),ctx));}
      if(action==='atribuir'&&!target)return renderBillProposal(await this.prepareAssignment(fields,ctx));
      if(action==='rejeitar'&&target){named(fields,[]);const c=r.candidates().find(c=>c.id===id(target));if(!c||c.state!=='pending')throw new AppError('BILL_NOT_FOUND');return renderBillProposal(r.propose('reject',{before:{id:c.id,state:c.state},after:{id:c.id,state:'rejected'},preview:`Rejeitar candidato ${c.id}. A rejeição permanece mesmo quando aparecem novas evidências; não remove lançamentos nem cadastros.`},ctx));}
      return {text:BILL_HELP};
    }
    if(command==='/proximos_vencimentos'){named(fields,[]);if(args.length>1)throw new AppError('INPUT_INVALID');const from=args[0]?month(args[0])+'-01':this.today(),to=args[0]?new Date(Date.parse(addMonths(args[0],1)+'-01T12:00:00Z')-86400000).toISOString().slice(0,10):new Date(Date.parse(from+'T12:00:00Z')+30*86400000).toISOString().slice(0,10);const upcoming=this.getUpcoming({from,to});return {text:`Calendário LOCAL ${from} a ${to}; ${upcoming.registeredCount} cadastros.\n${upcoming.items.map(i=>`${i.dueDate} (${i.dateKind}): ${label(i.name)} ${amountText(i.amountCents)}; /ocorrencia ${i.id}`).join('\n')||'Nenhum vencimento informado nessa janela.'}\nDocumento: chegada não verificada. Pagamento não inferido.`};}
    if(command==='/ocorrencia'&&args[0]!=='editar'){named(fields,[]);if(args.length!==1)throw new AppError('INPUT_INVALID');this.materialize();return {text:this.occurrenceText(r.occurrence(id(args[0])))};}
    const editing=command==='/ocorrencia'&&args[0]==='editar',target=editing?args[1]:args[0];if(args.length!==(editing?2:1))throw new AppError('INPUT_INVALID');const before=r.occurrence(id(target)),after=structuredClone(before);
    if(editing){named(fields,['vencimento','tipo_data','valor_centavos']);if(!Object.keys(fields).length)throw new AppError('INPUT_INVALID');if(before.localState!=='open')throw new AppError('BILL_CONFLICT');if('vencimento'in fields){if(!validDate(fields.vencimento)||!('tipo_data'in fields))throw new AppError('INPUT_INVALID');after.dueDate=fields.vencimento;after.adjusted=false;}if('tipo_data'in fields){after.dateKind=kind(fields.tipo_data);after.dateSource=after.dateKind==='confirmed'?'user_confirmed':'user_estimate';}if('valor_centavos'in fields)after.expectedAmountCents=reference(fields.valor_centavos);after.override=true;}
    else if(command==='/pago'){named(fields,['data']);if(before.localState!=='open')throw new AppError('BILL_CONFLICT');if(fields.data&&(!validDate(fields.data)||fields.data>this.today()))throw new AppError('INPUT_INVALID');after.localState='paid_manual';after.paidAt=fields.data??null;}
    else if(command==='/reabrir'){named(fields,[]);if(before.localState==='open')throw new AppError('BILL_CONFLICT');after.localState='open';after.paidAt=null;after.confirmedAt=null;}
    else if(command==='/cancelar_ocorrencia'){named(fields,[]);if(before.localState!=='open')throw new AppError('BILL_CONFLICT');after.localState='cancelled';}
    else throw new AppError('INPUT_INVALID');
    return renderBillProposal(r.propose('occurrence',{before,after,preview:`Ocorrência ${before.id}, unidade ${label(r.unit(before.unitId).name)}, competência ${before.competence}.\nEstado ${before.localState} → ${after.localState}; vencimento ${before.dueDate} (${before.dateKind}) → ${after.dueDate} (${after.dateKind}); valor ${amountText(before.expectedAmountCents)} → ${amountText(after.expectedAmountCents)}.\nData de pagamento informada: ${after.paidAt??'não informada'}. Cancelar é somente local; não cancela o serviço. Reabrir não desfaz pagamento bancário.`},ctx));
  }
}
