import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { StateStore } from '../src/storage/store.mjs';
import { identityFromConfig } from '../src/policy/authorize.mjs';
import { testConfig,tempDirectory } from './helpers.mjs';
import { financialSnapshot } from './fixtures/financial.mjs';
import { BillService } from '../src/application/bills.mjs';
import { BillScheduler } from '../src/jobs/bill-scheduler.mjs';
import { ReportScheduler } from '../src/jobs/scheduler.mjs';
import { Schedulers } from '../src/jobs/schedulers.mjs';
import { processOneDelivery,processOneJob } from '../src/jobs/runtime.mjs';
import { createCommandHandler } from '../src/telegram/commands.mjs';
import { parseBillCommand } from '../src/telegram/bills.mjs';
import { AppError } from '../src/errors.mjs';

const code=wanted=>e=>e instanceof AppError&&e.code===wanted;
function fixture(t,{at='2026-09-01T10:00:00Z',persistent=false,timezone=null}={}){
  let store;t.after(()=>{if(store?.db.open)store.close();});const directory=tempDirectory(t),config=timezone?{...testConfig(directory),timezone}:testConfig(directory),identity=identityFromConfig(config),filename=persistent?path.join(directory,'bills.sqlite'):':memory:';
  let clock=Date.parse(at),serial=0;const f={config,identity,reads:0,at:iso=>{clock=typeof iso==='number'?iso:Date.parse(iso);},get now(){return clock;},get store(){return store;}};
  const actual={snapshot:async period=>{f.reads++;if(f.error)throw f.error;await f.onRead?.();const s=financialSnapshot(period);s.transactionMetadataVersion='1';s.budgetMonths=[];s.syncedAt=new Date(clock).toISOString();const base=financialSnapshot().transactions[0];s.transactions=['2026-07-10','2026-08-10','2026-09-10'].map((date,i)=>({...base,id:`tx${i}`,date,amount:-10000,reconciled:false,startingBalance:false,scheduleId:null})).filter(row=>row.date>=period.start&&row.date<=period.end);f.mutate?.(s);return s;},readSchedules:async()=>{if(f.error)throw f.error;return {householdId:identity.householdId,budgetId:identity.budgetId,timezone:identity.timezone,currency:identity.currency,rulesVersion:'schedules-1',coverage:{complete:true},schedules:f.schedules??[],syncedAt:new Date(clock).toISOString()};}};
  const make=()=>{f.service=new BillService({config,store,actual,now:()=>new Date(clock)});f.scheduler=new BillScheduler({config,store,service:f.service,now:()=>clock});f.report=new ReportScheduler({config,store,actual,now:()=>clock,upcomingProvider:args=>f.service.getUpcoming(args)});f.composite=new Schedulers([f.report,f.scheduler]);f.handler=createCommandHandler({config,store,actual,now:()=>new Date(clock),billService:f.service,reportScheduler:f.report,intentClient:{interpret:()=>{throw new Error('MODEL_MUST_NOT_RUN');}}});};
  store=new StateStore(filename,identity,{now:()=>clock});make();
  f.enqueue=text=>{const payload={type:'message',text,identity};const id=store.enqueueJob({kind:'command',payload,dedupeKey:`test:${++serial}`});return {id,payload};};
  f.command=async text=>{const expected=f.enqueue(text),job=store.claimJob();assert.equal(job.id,expected.id);const message=await f.handler(job.payload,job);store.completeJob(job.id,message);return message;};
  f.proposal=()=>{const row=store.db.prepare('SELECT nonce FROM bill_proposals ORDER BY rowid DESC LIMIT 1').get();return f.service.repository.proposal(row.nonce,identity);};
  f.confirm=async()=>f.command(`/recorrencia confirmar ${f.proposal().nonce}`);
  f.unit=async(name='Casa')=>{await f.command(`/unidade cadastrar nome="${name}"`);const unitId=f.proposal().input.after.id;await f.confirm();return unitId;};
  f.bill=async(extra='',unitId)=>{const unit=unitId??await f.unit();await f.command(`/recorrencia cadastrar nome="Luz" unidade=${unit} favorecido=shop conta=checking inicio=${f.service.today().slice(0,7)} dia=20 mes_offset=0 tipo_data=confirmado valor_centavos=10000 ${extra}`);const billId=f.proposal().input.after.id;await f.confirm();return f.service.repository.bill(billId);};
  f.occurrence=(bill,competence='2026-09')=>f.service.repository.occurrences().find(o=>o.billId===bill.id&&o.competence===competence);
  f.reopen=()=>{store.close();store=new StateStore(filename,identity,{now:()=>clock});store.recover();make();};
  f.notices=()=>store.db.prepare('SELECT o.*,d.kind FROM outbox o JOIN bill_deliveries d ON d.outbox_id=o.id ORDER BY o.rowid').all().map(r=>({...r,payload:r.payload?JSON.parse(r.payload):null}));
  f.clearMessages=()=>store.db.prepare("UPDATE outbox SET state='sent' WHERE state='pending' AND id NOT IN (SELECT outbox_id FROM bill_deliveries)").run();
  return f;
}

test('closed Telegram grammar preserves names and rejects duplicate or malformed fields',()=>{
  assert.deepEqual(parseBillCommand('/unidade cadastrar nome="Casa A"'),{words:['/unidade','cadastrar'],fields:{nome:'Casa A'}});
  for(const text of ['/x nome="unterminated','/x nome=A nome=B','/x nome="A"suffix','/x nome=A positional','/x nome=A __proto__=value'])assert.throws(()=>parseBillCommand(text),code('INPUT_INVALID'));
});

test('local unit and recurring bill require exact confirmation and persist in dryRun without any SDK write',async t=>{
  const f=fixture(t);const before=f.reads;await f.command('/unidade cadastrar nome="Apartamento"');assert.equal(f.service.repository.units().length,0);assert.equal(f.reads,before);
  assert.match(f.proposal().input.preview,/Apartamento/);await f.confirm();const unit=f.service.repository.units()[0].id;
  const bill=await f.bill('',unit),o=f.occurrence(bill);assert.equal(f.config.dryRun,true);assert.ok(o);assert.equal(o.dueDate,'2026-09-20');assert.equal(bill.policy.remindersEnabled,false);assert.equal(bill.policy.variationEnabled,false);assert.equal(f.notices().length,0);
  assert.match((await f.command('/recorrencias')).text,/Nenhum lançamento comprova pagamento/);
});

test('expiry, wrong identity, policy change and duplicate confirmation cannot change local state',async t=>{
  const f=fixture(t);await f.command('/unidade cadastrar nome="Casa"');const nonce=f.proposal().nonce;
  await assert.rejects(f.service.handle({type:'callback',data:`rf:${nonce}`,identity:{...f.identity,userId:999}},{}),code('UNAUTHORIZED'));
  f.at(f.now+900000);await assert.rejects(f.command(`/recorrencia confirmar ${nonce}`),code('PROPOSAL_EXPIRED'));assert.equal(f.service.repository.units().length,0);
  await f.command('/unidade cadastrar nome="Nova"');const p=f.proposal();const configured=new BillService({config:{...f.config,dryRun:false},store:f.store,actual:{},now:()=>new Date(f.now)});const queued=f.enqueue(`/recorrencia confirmar ${p.nonce}`),job=f.store.claimJob();assert.equal(job.id,queued.id);await assert.rejects(configured.handle(job.payload,job),code('PROPOSAL_POLICY_CHANGED'));
  await f.confirm();assert.equal(f.service.repository.units().length,1);await assert.rejects(f.confirm(),code('PROPOSAL_USED'));assert.equal(f.service.repository.units().length,1);
});

test('local confirmation effect, nonce, audit and final outbox rollback together',async t=>{
  const f=fixture(t);await f.command('/unidade cadastrar nome="Casa"');const enqueue=f.store.enqueueOutbox;f.store.enqueueOutbox=()=>{throw new AppError('STORAGE_FAILED');};await assert.rejects(f.confirm(),code('STORAGE_FAILED'));assert.equal(f.service.repository.units().length,0);assert.equal(f.proposal().state,'pending');assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM bill_events WHERE kind='confirmed'").get().n,0);
  f.store.enqueueOutbox=enqueue;await f.confirm();assert.equal(f.service.repository.units().length,1);
});

test('crash after confirmed local commit replays same job result without a second effect or output',async t=>{
  const f=fixture(t,{persistent:true});await f.command('/unidade cadastrar nome="Casa"');const nonce=f.proposal().nonce;f.enqueue(`/recorrencia confirmar ${nonce}`);const job=f.store.claimJob();await f.handler(job.payload,job);
  const count=f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n;f.reopen();const replay=f.store.claimJob();assert.equal(replay.id,job.id);const result=await f.handler(replay.payload,replay);f.store.completeJob(replay.id,result);
  assert.equal(f.service.repository.units().length,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n,count);
});

test('calendar and local reminder tick run while Actual and model are unavailable',async t=>{
  const f=fixture(t),bill=await f.bill('lembretes=sim');f.error=new AppError('ACTUAL_TIMEOUT');const reads=f.reads;f.at('2026-09-13T11:00:00Z');f.scheduler.tick();assert.equal(f.reads,reads);assert.equal(f.notices().filter(n=>n.state==='pending').length,1);assert.match(f.notices()[0].payload.text,/em 7 dia/);
  assert.match((await f.command('/proximos_vencimentos 2026-09')).text,/2026-09-20/);assert.match((await f.command(`/ocorrencia ${f.occurrence(bill).id}`)).text,/planejado/);
});

test('restart coalesces reminder stages, re-renders actual days before send and preserves uncertain outcomes',async t=>{
  const f=fixture(t,{persistent:true});await f.bill('lembretes=sim');f.clearMessages();f.at('2026-09-13T11:00:00Z');f.scheduler.tick();
  f.at('2026-09-19T12:00:00Z');f.reopen();f.scheduler.tick();assert.equal(f.notices().filter(n=>n.state==='pending').length,1);assert.equal(f.notices()[0].state,'failed');
  let sent;await processOneDelivery({store:f.store,scheduler:f.composite,telegram:{sendMessage:async(_chat,payload)=>{sent=payload.text;throw new Error('NETWORK_CANARY');}},logger:()=>{}});assert.match(sent,/em 1 dia/);assert.ok(f.notices().some(n=>n.state==='uncertain'));
  f.scheduler.tick();assert.equal(f.notices().filter(n=>n.state==='pending').length,0);f.at(f.now+91*86400000);f.scheduler.prune(90);assert.equal(f.notices().find(n=>n.state==='uncertain').payload,null);
});

test('future template edits preserve current effective activity, closed occurrences, overrides and stable IDs',async t=>{
  const f=fixture(t),bill=await f.bill('lembretes=sim'),current=f.occurrence(bill),october=f.occurrence(bill,'2026-10');
  await f.command(`/pago ${current.id}`);await f.confirm();await f.command(`/cancelar_ocorrencia ${october.id}`);await f.confirm();
  await f.command(`/recorrencia editar ${bill.id} a_partir=2026-10 dia=31 mes_offset=1 ativa=nao`);await f.confirm();
  assert.equal(f.service.effectiveBill(bill.id,'2026-09').active,true);assert.equal(f.service.effectiveBill(bill.id,'2026-10').active,false);
  const paid=f.service.repository.occurrence(current.id),cancelled=f.service.repository.occurrence(october.id);assert.equal(paid.localState,'paid_manual');assert.equal(paid.dueDate,'2026-09-20');assert.equal(paid.paidAt,null);assert.equal(cancelled.localState,'cancelled');assert.equal(cancelled.dueDate,'2026-10-20');
  assert.equal(f.service.getUpcoming({from:'2026-11-01',to:'2026-11-30'}).items.length,0);
});

test('manual paid/reopen/cancel are local audited proposals and estimated dates never claim debt',async t=>{
  const f=fixture(t),bill=await f.bill(),o=f.occurrence(bill);await f.command(`/ocorrencia editar ${o.id} tipo_data=estimado`);await f.confirm();f.at('2026-09-25T12:00:00Z');
  const text=(await f.command(`/ocorrencia ${o.id}`)).text;assert.match(text,/data estimada ultrapassada/);assert.doesNotMatch(text,/Estado: vencimento confirmado/);
  f.error=new AppError('ACTUAL_TIMEOUT');await f.command(`/pago ${o.id} data=2026-09-24`);await f.confirm();assert.equal(f.service.repository.occurrence(o.id).paidAt,'2026-09-24');
  await f.command(`/reabrir ${o.id}`);await f.confirm();assert.equal(f.service.repository.occurrence(o.id).localState,'open');await f.command(`/cancelar_ocorrencia ${o.id}`);await f.confirm();assert.equal(f.service.repository.occurrence(o.id).localState,'cancelled');
});

test('three-month candidates require explicit units; rejection survives new evidence and stale support cannot be adopted',async t=>{
  const f=fixture(t,{at:'2026-09-15T12:00:00Z'}),unit=await f.unit();let result=await f.service.refresh();assert.equal(result.detected.candidates.length,0);
  const proposal=await f.command(`/recorrencia atribuir unidade=${unit} lancamentos=tx0,tx1,tx2`);assert.match(proposal.text,/2026-07-10/);assert.match(proposal.text,/-R\$ 100,00/);assert.match(proposal.text,/não atribuída/);await f.confirm();result=await f.service.refresh();assert.equal(result.detected.candidates.length,1);const c=result.detected.candidates[0];
  await f.command(`/recorrencia cadastrar nome="Luz" unidade=${unit} favorecido=shop conta=checking inicio=2026-09 dia=20 mes_offset=0 tipo_data=confirmado valor_centavos=10000 candidato=${c.id}`);f.mutate=s=>{s.transactions=s.transactions.filter(t=>t.id!=='tx1');};await assert.rejects(f.confirm(),code('BILL_EVIDENCE_STALE'));assert.equal(f.service.localBills().length,0);
  f.mutate=null;await f.command(`/recorrencia rejeitar ${c.id}`);await f.confirm();await f.service.refresh();assert.equal(f.service.repository.candidates()[0].state,'rejected');await assert.rejects(f.command(`/recorrencia cadastrar nome="Luz" unidade=${unit} favorecido=shop conta=checking inicio=2026-09 dia=20 mes_offset=0 tipo_data=confirmado valor_centavos=10000 candidato=${c.id}`),code('BILL_EVIDENCE_STALE'));
});

test('assignment fingerprints, source schedule fingerprints and old snapshot metadata are revalidated',async t=>{
  const f=fixture(t,{at:'2026-09-15T12:00:00Z'}),unit=await f.unit();await f.command(`/recorrencia atribuir unidade=${unit} lancamentos=tx0`);f.mutate=s=>{s.transactions[0].amount=-20000;};await assert.rejects(f.confirm(),code('BILL_EVIDENCE_STALE'));assert.equal(f.service.repository.assignments().length,0);
  f.mutate=null;f.schedules=[{id:'schedule1',name:'Conta',payeeId:'shop',accountId:'checking',fingerprint:'a'.repeat(64)}];await f.command(`/recorrencia cadastrar nome="Luz" unidade=${unit} favorecido=shop conta=checking inicio=2026-09 dia=20 mes_offset=0 tipo_data=confirmado valor_centavos=10000 agendamento=schedule1`);f.schedules[0].fingerprint='b'.repeat(64);await assert.rejects(f.confirm(),code('BILL_EVIDENCE_STALE'));
  f.mutate=s=>{delete s.transactionMetadataVersion;};await assert.rejects(f.command(`/recorrencia atribuir unidade=${unit} lancamentos=tx0`),code('SNAPSHOT_INVALID'));
});

test('unique mapping supports monthly observation while future/historical unit conflict never remaps old evidence',async t=>{
  const f=fixture(t,{at:'2026-09-30T12:00:00Z'}),bill=await f.bill(),o=f.occurrence(bill);await f.command(`/ocorrencia editar ${o.id} vencimento=2026-09-10 tipo_data=confirmado`);await f.confirm();let fresh=await f.service.refresh();assert.equal(fresh.matched.matches.find(m=>m.occurrenceId===o.id).state,'compatible');assert.equal(f.service.repository.occurrence(o.id).localState,'open');
  const unitB=await f.unit('Casa B');await f.command(`/recorrencia editar ${bill.id} a_partir=2026-10 unidade=${unitB}`);await f.confirm();fresh=await f.service.refresh();assert.equal(fresh.matched.matches.find(m=>m.occurrenceId===o.id).state,'compatible','future version does not apply yet');f.at('2026-10-01T12:00:00Z');fresh=await f.service.refresh();assert.equal(fresh.matched.matches.find(m=>m.occurrenceId===o.id).state,'unknown');assert.equal(f.service.repository.occurrence(o.id).unitId,bill.unitId);
});

test('variation uses configured AND limits, fresh scope, current revision and never marks paid',async t=>{
  const f=fixture(t,{at:'2026-09-30T12:00:00Z'}),bill=await f.bill('variacao=sim'),o=f.occurrence(bill);await f.command(`/ocorrencia editar ${o.id} vencimento=2026-09-10 tipo_data=confirmado`);await f.confirm();
  f.mutate=s=>{s.transactions.find(t=>t.id==='tx2').amount=-12000;};await f.service.refresh();f.scheduler.tick();assert.equal(f.notices().filter(n=>n.kind==='variation').length,0);
  f.mutate=s=>{s.transactions.find(t=>t.id==='tx2').amount=-13000;};await f.service.refresh();f.scheduler.tick();assert.equal(f.notices().filter(n=>n.kind==='variation').length,1);assert.equal(f.service.repository.occurrence(o.id).localState,'open');
  const notice=f.notices().find(n=>n.kind==='variation');f.store.setPreference('finance_scope',{includeClosed:true,includeOffBudget:false});assert.equal(f.scheduler.authorizeDelivery({id:notice.id,payload:notice.payload}),false);
  f.error=new AppError('ACTUAL_TIMEOUT');await assert.rejects(f.service.refresh());assert.equal(f.scheduler.authorizeDelivery({id:notice.id,payload:notice.payload}),false);
});

test('migrations 004-009 upgrade a database containing only 001-003 without changing report preferences',t=>{
  const dir=tempDirectory(t),file=path.join(dir,'old.sqlite'),config=testConfig(dir),db=new Database(file);db.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER NOT NULL)');
  for(const fileName of ['001_core.sql','002_operations.sql','003_reports.sql']){db.exec(readFileSync(new URL('../migrations/'+fileName,import.meta.url),'utf8'));db.prepare('INSERT INTO schema_migrations VALUES(?,0)').run(fileName);}
  db.prepare('INSERT INTO households VALUES(?,?,?)').run(config.householdId,config.timezone,config.currency);db.prepare('INSERT INTO preferences VALUES(?,?,?)').run(config.householdId,'finance_scope',JSON.stringify({includeClosed:true,includeOffBudget:false}));db.prepare('INSERT INTO metadata VALUES(?,?)').run('telegram_next_send_at','123456');db.close();
  const upgraded=new StateStore(file,identityFromConfig(config));try{assert.deepEqual(upgraded.db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map(row=>row.name),['001_core.sql','002_operations.sql','003_reports.sql','004_bills.sql','005_assistant_actions.sql','006_conversations.sql','007_outbox_media.sql','008_financial_companion.sql','009_companion_proposals.sql']);assert.ok(upgraded.db.prepare("SELECT name FROM sqlite_master WHERE name='bill_proposals'").get());assert.ok(upgraded.db.prepare("SELECT name FROM sqlite_master WHERE name='financial_goals'").get());assert.ok(upgraded.db.prepare("SELECT name FROM sqlite_master WHERE name='companion_proposals'").get());assert.deepEqual(upgraded.getPreference('finance_scope'),{includeClosed:true,includeOffBudget:false});assert.equal(upgraded.db.prepare("SELECT value FROM metadata WHERE key='telegram_next_send_at'").get().value,'123456');}finally{upgraded.close();}
});

test('pending source changes refresh one variation episode; metadata edits, repeated sync and hysteresis do not spam',async t=>{
  const f=fixture(t,{at:'2026-09-30T12:00:00Z'}),bill=await f.bill('variacao=sim'),o=f.occurrence(bill);await f.command(`/ocorrencia editar ${o.id} vencimento=2026-09-10 tipo_data=confirmado`);await f.confirm();let amount=-13000,notes='';f.mutate=s=>{const tx=s.transactions.find(t=>t.id==='tx2');tx.amount=amount;tx.notes=notes;};
  await f.service.refresh();f.scheduler.tick();let notice=f.notices()[0];const firstHash=f.store.db.prepare('SELECT match_fingerprint FROM bill_deliveries WHERE outbox_id=?').get(notice.id).match_fingerprint;
  notes='metadado alterado';await f.service.refresh();f.scheduler.tick();assert.equal(f.notices().length,1);assert.notEqual(f.store.db.prepare('SELECT match_fingerprint FROM bill_deliveries WHERE outbox_id=?').get(notice.id).match_fingerprint,firstHash);assert.equal(f.scheduler.authorizeDelivery({id:notice.id,payload:notice.payload}),true);
  await f.service.refresh();f.scheduler.tick();assert.equal(f.notices().length,1);f.store.db.prepare("UPDATE outbox SET state='uncertain' WHERE id=?").run(notice.id);
  notes='mais metadados';await f.service.refresh();f.scheduler.tick();assert.equal(f.notices().length,1);amount=-11900;await f.service.refresh();f.scheduler.tick();assert.equal(f.store.db.prepare('SELECT active FROM bill_variation_state').get().active,1);
  amount=-11800;await f.service.refresh();f.scheduler.tick();assert.equal(f.store.db.prepare('SELECT active FROM bill_variation_state').get().active,0);amount=-13000;await f.service.refresh();f.scheduler.tick();assert.equal(f.notices().length,2);assert.equal(f.notices()[0].state,'uncertain');assert.equal(f.store.db.prepare('SELECT episode FROM bill_variation_state').get().episode,2);
});

test('reminder 429 pending is invalidated by offline confirmed opt-out and queued reconciliation is cancelled',async t=>{
  const f=fixture(t),bill=await f.bill('lembretes=sim');f.clearMessages();f.at('2026-09-13T11:00:00Z');f.scheduler.tick();
  await processOneDelivery({store:f.store,scheduler:f.composite,telegram:{sendMessage:async()=>{throw new AppError('TELEGRAM_RATE_LIMITED',{retryAfterSeconds:3600});}},logger:()=>{}});assert.equal(f.notices()[0].state,'pending');
  f.error=new AppError('ACTUAL_TIMEOUT');await f.command(`/recorrencia editar ${bill.id} a_partir=2026-09 lembretes=nao`);await f.confirm();f.scheduler.tick();assert.equal(f.notices()[0].state,'failed');assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='bill_reconcile' AND state='queued'").get().n,0);
});

test('reminder civil fold fires once and spring gap uses the first valid minute',async t=>{
  for(const sample of [{at:'2026-10-30T12:00:00Z',competence:'2026-11',due:'2026-11-01',time:'01:30',first:'2026-11-01T05:30:00Z',later:'2026-11-01T06:30:00Z'},{at:'2026-03-01T12:00:00Z',competence:'2026-03',due:'2026-03-08',time:'02:30',first:'2026-03-08T07:00:00Z',later:'2026-03-08T07:30:00Z'}]){
    const f=fixture(t,{at:sample.at,timezone:'America/New_York'});f.mutate=s=>{s.timezone='America/New_York';};const bill=await f.bill(`lembretes=sim dias=0 horario=${sample.time}`),o=f.occurrence(bill,sample.competence);await f.command(`/ocorrencia editar ${o.id} vencimento=${sample.due} tipo_data=confirmado`);await f.confirm();f.at(sample.first);f.scheduler.tick();assert.equal(f.notices().length,1);assert.match(f.notices()[0].payload.text,/hoje/);f.at(sample.later);f.scheduler.tick();assert.equal(f.notices().length,1);
  }
});

test('an in-flight SDK reconciliation cannot block local tick and reminder delivery',async t=>{
  const f=fixture(t);await f.bill('lembretes=sim');f.clearMessages();f.scheduler.tick();let release,entered;const started=new Promise(resolve=>{entered=resolve;});f.onRead=()=>{entered();return new Promise(resolve=>{release=resolve;});};
  const pending=processOneJob({store:f.store,scheduler:f.composite,handler:f.handler,telegram:{},logger:()=>{}});await started;
  f.at('2026-09-13T11:00:00Z');let sends=0;await processOneDelivery({store:f.store,scheduler:f.composite,telegram:{sendMessage:async()=>++sends},logger:()=>{}});assert.equal(sends,1);release();await pending;
});

test('local reminder event and outbox are atomic under failure and retry',async t=>{
  const f=fixture(t);await f.bill('lembretes=sim');f.at('2026-09-13T11:00:00Z');const enqueue=f.store.enqueueOutbox;f.store.enqueueOutbox=()=>{throw new AppError('STORAGE_FAILED');};assert.throws(()=>f.scheduler.tick(),code('STORAGE_FAILED'));assert.equal(f.notices().length,0);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM bill_events WHERE kind='notification_reminder'").get().n,0);
  f.store.enqueueOutbox=enqueue;f.scheduler.tick();assert.equal(f.notices().length,1);f.scheduler.tick();assert.equal(f.notices().length,1);
});

test('public unresolved evidence exposes real IDs and financial context; same-name upcoming bills show units',async t=>{
  const f=fixture(t,{at:'2026-09-15T12:00:00Z'});const pending=await f.command('/recorrencias pendencias');assert.match(pending.text,/tx0: 2026-07-10/);assert.match(pending.text,/Loja fictícia/);assert.match(pending.text,/recorrencia atribuir/);
  await f.bill('',await f.unit('Casa A'));await f.bill('',await f.unit('Casa B'));const upcoming=f.service.getUpcoming({from:'2026-09-15',to:'2026-09-22'});assert.equal(upcoming.items.length,2);assert.ok(upcoming.items.some(i=>i.name==='Luz (Casa A)'));assert.ok(upcoming.items.some(i=>i.name==='Luz (Casa B)'));
  const report=await f.command('/relatorio');assert.match(report.text,/Próximos vencimentos — calendário local/);assert.match(report.text,/Luz \(Casa A\)/);assert.match(report.text,/Luz \(Casa B\)/);
});

test('future pause remains visible as scheduled and does not stop current reminder or reconciliation',async t=>{
  const f=fixture(t),bill=await f.bill('lembretes=sim');await f.command(`/recorrencia editar ${bill.id} a_partir=2026-10 ativa=nao`);await f.confirm();const list=await f.command('/recorrencias');assert.match(list.text,/Versão vigente neste mês/);assert.match(list.text,/VERSÃO PROGRAMADA desde 2026-10/);
  f.at('2026-09-13T11:00:00Z');f.scheduler.tick();assert.equal(f.notices().length,1);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='bill_reconcile' AND state='queued'").get().n,1);assert.equal(f.service.getUpcoming({from:'2026-09-15',to:'2026-09-30'}).items.length,1);
});

test('clock rollback after latest catchup cannot introduce skipped earlier reminder stages',async t=>{
  const f=fixture(t);await f.bill('lembretes=sim');f.at('2026-09-19T11:00:00Z');f.scheduler.tick();assert.equal(f.notices().length,1);f.store.db.prepare("UPDATE outbox SET state='uncertain' WHERE id=?").run(f.notices()[0].id);
  f.at('2026-09-13T11:00:00Z');f.scheduler.tick();assert.equal(f.notices().length,1);f.at('2026-09-19T12:00:00Z');f.scheduler.tick();assert.equal(f.notices().length,1);
});

test('authenticated recurrence callbacks use their own nonce and replay cannot apply twice',async t=>{
  const f=fixture(t);const response=await f.command('/unidade cadastrar nome="Casa"'),p=f.proposal();assert.ok(response.replyMarkup.inline_keyboard[0].every(b=>Buffer.byteLength(b.callback_data)<=64));
  const payload={type:'callback',callbackId:'synthetic-callback',data:`rf:${p.nonce}`,identity:f.identity};const jobId=f.store.enqueueJob({kind:'command',payload,dedupeKey:'callback:bill',safeRetry:true}),job=f.store.claimJob();assert.equal(job.id,jobId);const result=await f.handler(payload,job);f.store.completeJob(job.id,result);assert.equal(f.service.repository.units().length,1);
  const second=f.store.enqueueJob({kind:'command',payload,dedupeKey:'callback:bill:again',safeRetry:true}),duplicate=f.store.claimJob();assert.equal(duplicate.id,second);await assert.rejects(f.handler(payload,duplicate),code('PROPOSAL_USED'));assert.equal(f.service.repository.units().length,1);
});

test('closed fields, invalid cents/rules and bad catalog IDs never prepare a recurrence',async t=>{
  const f=fixture(t),unit=await f.unit(),base=`/recorrencia cadastrar nome="Luz" unidade=${unit} favorecido=shop conta=checking inicio=2026-09 dia=20 mes_offset=0 tipo_data=confirmado valor_centavos=10000`;
  for(const text of [base+' sdk_method=deleteAll',base+' __proto__=bad',base.replace('dia=20','dia=32'),base.replace('mes_offset=0','mes_offset=2'),base.replace('10000','10.50'),base+' dias=1,1'])await assert.rejects(f.command(text),code('INPUT_INVALID'));
  await assert.rejects(f.command(base.replace('conta=checking','conta=typo')),code('BILL_EVIDENCE_STALE'));assert.equal(f.service.localBills().length,0);
});

test('Actual schedules are observed sources and local monthly adaptation is explicit before confirmation',async t=>{
  const f=fixture(t),unit=await f.unit();f.schedules=[{id:'schedule-week',name:'Semanal',payeeId:'shop',accountId:'checking',fingerprint:'a'.repeat(64),nextDate:'2026-09-07',date:{frequency:'weekly',endMode:'after_n_occurrences',endOccurrences:5,weekend:'after'},amountCents:-10000,amountOp:'is',completed:false}];
  const catalog=await f.command('/recorrencias agendamentos');assert.match(catalog.text,/2026-09-07/);assert.match(catalog.text,/cadastro local é mensal/);assert.match(catalog.text,/semanal\/anual, endN e ajuste de fim de semana não são copiados/);
  const proposal=await f.command(`/recorrencia cadastrar nome="Luz" unidade=${unit} favorecido=shop conta=checking inicio=2026-09 dia=20 mes_offset=0 tipo_data=confirmado valor_centavos=10000 agendamento=schedule-week`);assert.match(proposal.text,/cadastro local é mensal/);assert.match(proposal.text,/não são copiados nem expandidos automaticamente/);assert.equal(f.service.repository.bills().length,0);
});

test('negative evidence before activation or after clock rollback cannot reset a variation episode',async t=>{
  const f=fixture(t,{at:'2026-09-30T12:00:00Z'}),bill=await f.bill('variacao=sim'),original=f.occurrence(bill);await f.command(`/ocorrencia editar ${original.id} vencimento=2026-09-10 tipo_data=confirmado`);await f.confirm();const o=f.service.repository.occurrence(original.id),policy=f.scheduler.policy(o);f.mutate=s=>{s.transactions.find(t=>t.id==='tx2').amount=-13000;};await f.service.refresh();f.scheduler.tick();const match=f.service.repository.match(o.id),instant=f.now;
  f.service.repository.saveMatch({...match,state:'none',evidence:[],observedAt:instant+60000});f.scheduler.variation(o,policy);assert.equal(f.store.db.prepare('SELECT active FROM bill_variation_state').get().active,1);
  f.service.repository.saveMatch({...match,state:'none',evidence:[],observedAt:policy.policy.since-1});f.scheduler.variation(o,policy);assert.equal(f.store.db.prepare('SELECT active FROM bill_variation_state').get().active,1);
  f.service.repository.saveMatch({...match,state:'none',evidence:[],observedAt:instant});f.at(instant-1000);f.scheduler.variation(o,policy);assert.equal(f.store.db.prepare('SELECT active FROM bill_variation_state').get().active,1);assert.equal(f.notices().length,1);
  f.at(instant);f.scheduler.variation(o,policy);assert.equal(f.store.db.prepare('SELECT active FROM bill_variation_state').get().active,0);
});

test('variation changing direction must cross entry thresholds again before another episode',async t=>{
  const f=fixture(t,{at:'2026-09-30T12:00:00Z'}),bill=await f.bill('variacao=sim'),o=f.occurrence(bill);await f.command(`/ocorrencia editar ${o.id} vencimento=2026-09-10 tipo_data=confirmado`);await f.confirm();let amount=-12500;f.mutate=s=>{s.transactions.find(t=>t.id==='tx2').amount=amount;};await f.service.refresh();f.scheduler.tick();assert.equal(f.notices().length,1);assert.equal(f.store.db.prepare('SELECT direction FROM bill_variation_state').get().direction,'increase');
  amount=-8100;await f.service.refresh();f.scheduler.tick();assert.equal(f.notices().length,1);assert.equal(f.store.db.prepare('SELECT active FROM bill_variation_state').get().active,0);
  amount=-7500;await f.service.refresh();f.scheduler.tick();assert.equal(f.notices().length,2);assert.equal(f.store.db.prepare('SELECT direction,episode FROM bill_variation_state').get().direction,'decrease');assert.equal(f.store.db.prepare('SELECT episode FROM bill_variation_state').get().episode,2);
});

test('future policy changes preserve an already pending reminder of the current competence',async t=>{
  const f=fixture(t),bill=await f.bill('lembretes=sim');f.at('2026-09-13T11:00:00Z');f.scheduler.tick();const notice=f.notices()[0];await f.command(`/recorrencia editar ${bill.id} a_partir=2026-10 ativa=nao`);await f.confirm();assert.equal(f.notices().find(n=>n.id===notice.id).state,'pending');assert.equal(f.scheduler.authorizeDelivery({id:notice.id,payload:notice.payload}),true);f.scheduler.tick();assert.equal(f.notices().filter(n=>n.state==='pending').length,1);
});

test('shortened competence range retires open dates from reminders while preserving closed history',async t=>{
  const f=fixture(t),bill=await f.bill('lembretes=sim'),october=f.occurrence(bill,'2026-10'),november=f.occurrence(bill,'2026-11');await f.command(`/pago ${november.id}`);await f.confirm();f.at('2026-10-13T11:00:00Z');f.scheduler.tick();const notice=f.notices().find(n=>n.payload.text.includes(october.id));assert.equal(notice.state,'pending');await f.command(`/recorrencia editar ${bill.id} a_partir=2026-10 fim=2026-09`);await f.confirm();assert.equal(f.service.getUpcoming({from:'2026-10-01',to:'2026-10-31'}).items.length,0);assert.equal(f.scheduler.authorizeDelivery({id:notice.id,payload:notice.payload}),false);assert.equal(f.notices().find(n=>n.id===notice.id).state,'failed');assert.equal(f.service.repository.occurrence(november.id).localState,'paid_manual');assert.equal(f.service.repository.occurrence(october.id).id,october.id);assert.match((await f.command(`/ocorrencia ${october.id}`)).text,/fora da agenda atual por pausa\/fim\/vigência/);
});

test('confirmed assignment immediately invalidates old matching and pending variation before another read',async t=>{
  const f=fixture(t,{at:'2026-09-30T12:00:00Z'}),first=await f.unit('Casa A'),second=await f.unit('Casa B'),bill=await f.bill('variacao=sim',first),o=f.occurrence(bill);await f.command(`/ocorrencia editar ${o.id} vencimento=2026-09-10 tipo_data=confirmado`);await f.confirm();f.mutate=s=>{s.transactions.find(t=>t.id==='tx2').amount=-13000;};await f.service.refresh();f.scheduler.tick();const notice=f.notices()[0];assert.equal(f.scheduler.authorizeDelivery({id:notice.id,payload:notice.payload}),true);await f.command(`/recorrencia atribuir unidade=${second} lancamentos=tx2`);await f.confirm();assert.equal(f.service.repository.match(o.id).dataState,'stale');assert.equal(f.scheduler.authorizeDelivery({id:notice.id,payload:notice.payload}),false);assert.equal(f.notices()[0].state,'failed');assert.match((await f.command(`/ocorrencia ${o.id}`)).text,/observação desatualizada/);
});

test('all historical competitors exist before matching regardless of previous calendar queries',async t=>{
  const f=fixture(t,{at:'2026-09-30T12:00:00Z'}),unit=await f.unit();
  const create=async label=>{await f.command(`/recorrencia cadastrar nome="${label}" unidade=${unit} favorecido=shop conta=checking inicio=2026-07 dia=10 mes_offset=0 tipo_data=confirmado valor_centavos=10000`);const id=f.proposal().input.after.id;await f.confirm();return id;};
  const first=await create('A');await f.command('/proximos_vencimentos 2026-07');const second=await create('B');await f.service.refresh();let rows=f.service.repository.occurrences().filter(o=>o.competence==='2026-07'&&[first,second].includes(o.billId));assert.equal(rows.length,2);for(const o of rows)assert.equal(f.service.repository.match(o.id).state,'ambiguous');await f.command('/proximos_vencimentos 2026-07');await f.service.refresh();for(const o of rows)assert.equal(f.service.repository.match(o.id).state,'ambiguous');
});

test('domain validation failure revokes freshness of an earlier match without authorizing its pending alert',async t=>{
  const f=fixture(t,{at:'2026-09-30T12:00:00Z'}),bill=await f.bill('variacao=sim'),o=f.occurrence(bill);await f.command(`/ocorrencia editar ${o.id} vencimento=2026-09-10 tipo_data=confirmado`);await f.confirm();f.mutate=s=>{s.transactions.find(t=>t.id==='tx2').amount=-13000;};await f.service.refresh();f.scheduler.tick();const notice=f.notices()[0];assert.equal(f.scheduler.authorizeDelivery({id:notice.id,payload:notice.payload}),true);
  f.mutate=s=>{s.transactions.find(t=>t.id==='tx2').amount=-Number.MAX_SAFE_INTEGER;};await assert.rejects(f.service.refresh(),code('SNAPSHOT_INVALID'));assert.equal(f.service.repository.match(o.id).dataState,'stale');assert.equal(f.scheduler.authorizeDelivery({id:notice.id,payload:notice.payload}),false);assert.equal(f.store.db.prepare('SELECT active FROM bill_variation_state').get().active,1);
});

test('a new competing bill invalidates exclusive matching before any further Actual read',async t=>{
  const f=fixture(t,{at:'2026-09-30T12:00:00Z'}),unit=await f.unit(),bill=await f.bill('variacao=sim',unit),o=f.occurrence(bill);await f.command(`/ocorrencia editar ${o.id} vencimento=2026-09-10 tipo_data=confirmado`);await f.confirm();f.mutate=s=>{s.transactions.find(t=>t.id==='tx2').amount=-13000;};await f.service.refresh();f.scheduler.tick();const notice=f.notices()[0];assert.equal(f.scheduler.authorizeDelivery({id:notice.id,payload:notice.payload}),true);
  await f.command(`/recorrencia cadastrar nome="Concorrente" unidade=${unit} favorecido=shop conta=checking inicio=2026-09 dia=10 mes_offset=0 tipo_data=confirmado valor_centavos=10000`);await f.confirm();assert.equal(f.scheduler.authorizeDelivery({id:notice.id,payload:notice.payload}),false);assert.equal(f.notices()[0].state,'failed');await f.service.refresh();assert.equal(f.service.repository.match(o.id).state,'ambiguous');
});

test('fresh revalidation resumes a cancelled-before-send variation row but never a sent or uncertain episode',async t=>{
  const f=fixture(t,{at:'2026-09-30T12:00:00Z'}),unit=await f.unit(),bill=await f.bill('variacao=sim',unit),o=f.occurrence(bill);await f.command(`/ocorrencia editar ${o.id} vencimento=2026-09-10 tipo_data=confirmado`);await f.confirm();f.mutate=s=>{s.transactions.find(t=>t.id==='tx2').amount=-13000;};await f.service.refresh();f.scheduler.tick();const notice=f.notices()[0];await f.command(`/recorrencia atribuir unidade=${unit} lancamentos=tx2`);await f.confirm();assert.equal(f.notices()[0].state,'failed');await f.service.refresh();f.scheduler.tick();assert.equal(f.notices().length,1);assert.equal(f.notices()[0].state,'pending');assert.equal(f.notices()[0].id,notice.id);assert.equal(f.store.db.prepare('SELECT episode FROM bill_variation_state').get().episode,1);
  for(const state of ['sent','uncertain']){f.store.db.prepare('UPDATE outbox SET state=? WHERE id=?').run(state,notice.id);await f.command(`/recorrencia atribuir unidade=${unit} lancamentos=tx2`);await f.confirm();await f.service.refresh();f.scheduler.tick();assert.equal(f.notices().length,1);assert.equal(f.notices()[0].state,state);}
});

test('resumed variation uses current occurrence revision and sends once through runtime after date edit and restart',async t=>{
  const f=fixture(t,{at:'2026-09-30T12:00:00Z',persistent:true}),bill=await f.bill('variacao=sim'),o=f.occurrence(bill);await f.command(`/ocorrencia editar ${o.id} vencimento=2026-09-10 tipo_data=confirmado`);await f.confirm();f.mutate=s=>{s.transactions.find(t=>t.id==='tx2').amount=-13000;};await f.service.refresh();f.scheduler.tick();const notice=f.notices()[0];await f.command(`/ocorrencia editar ${o.id} vencimento=2026-09-11 tipo_data=confirmado`);await f.confirm();await f.service.refresh();f.scheduler.tick();const current=f.service.repository.occurrence(o.id);assert.equal(f.store.db.prepare('SELECT occurrence_revision FROM bill_deliveries WHERE outbox_id=?').get(notice.id).occurrence_revision,current.revision);assert.ok(f.store.db.prepare("SELECT id FROM bill_events WHERE kind='notification_revalidated'").get());f.clearMessages();let sends=0;await processOneDelivery({store:f.store,scheduler:f.composite,telegram:{sendMessage:async()=>++sends},logger:()=>{}});assert.equal(sends,1);assert.equal(f.notices()[0].state,'sent');f.reopen();f.at(f.now+2000);f.scheduler.tick();await processOneDelivery({store:f.store,scheduler:f.composite,telegram:{sendMessage:async()=>++sends},logger:()=>{}});assert.equal(sends,1);assert.equal(f.notices().length,1);
});

test('a future unit whose due window already intersects observed dates prevents false exclusivity at month boundary',async t=>{
  const f=fixture(t,{at:'2026-09-30T12:00:00Z'}),a=await f.unit('Casa A'),b=await f.unit('Casa B');f.mutate=s=>{const tx=s.transactions.find(t=>t.id==='tx2');tx.date='2026-09-29';tx.amount=-13000;};
  const create=async(unit,start,day,extra='')=>{await f.command(`/recorrencia cadastrar nome="Energia" unidade=${unit} favorecido=shop conta=checking inicio=${start} dia=${day} mes_offset=0 tipo_data=confirmado valor_centavos=10000 ${extra}`);const billId=f.proposal().input.after.id;await f.confirm();return f.service.repository.bill(billId);};
  const first=await create(a,'2026-09',30,'variacao=sim'),o=f.occurrence(first);await f.service.refresh();f.scheduler.tick();const notice=f.notices()[0];assert.equal(f.service.repository.match(o.id).state,'compatible');assert.equal(f.scheduler.authorizeDelivery({id:notice.id,payload:notice.payload}),true);
  const future=await create(b,'2026-10',1);assert.equal(f.scheduler.authorizeDelivery({id:notice.id,payload:notice.payload}),false);assert.equal(f.service.knownBills().length,2);await f.service.refresh();assert.notEqual(f.service.repository.match(o.id).state,'compatible');assert.notEqual(f.service.repository.match(f.occurrence(future,'2026-10').id).state,'compatible');assert.equal(f.service.repository.occurrence(o.id).localState,'open');
});
