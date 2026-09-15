import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { StateStore } from '../src/storage/store.mjs';
import { identityFromConfig } from '../src/policy/authorize.mjs';
import { testConfig,tempDirectory } from './helpers.mjs';
import { financialSnapshot } from './fixtures/financial.mjs';
import { ReportScheduler,ALERT_INTERVAL_MS } from '../src/jobs/scheduler.mjs';
import { resolveCivilTime,latestDailyOccurrence } from '../src/jobs/civil-time.mjs';
import { AppError } from '../src/errors.mjs';
import { createCommandHandler } from '../src/telegram/commands.mjs';
import { processOneJob,processOneDelivery } from '../src/jobs/runtime.mjs';

function fixture(t,{at='2026-09-15T10:00:01Z',persistent=false,real=false}={}) {
  let store;
  t.after(()=>{if(store?.db.open)store.close();});
  const directory=tempDirectory(t),config=testConfig(directory),identity=identityFromConfig(config),filename=persistent?path.join(directory,'state.sqlite'):':memory:';
  let clock=Date.parse(at);
  store=new StateStore(filename,identity,{now:()=>clock});
  const f={config,identity,reads:0,candidates:[],at:iso=>{clock=typeof iso==='number'?iso:Date.parse(iso);},get now(){return clock;},get store(){return store;}};
  f.actual={snapshot:async period=>{
    f.reads++; if(f.readError)throw f.readError; await f.onRead?.();
    const snapshot=financialSnapshot(period); snapshot.syncedAt=new Date(clock).toISOString(); f.changeSnapshot?.(snapshot); return snapshot;
  }};
  const mock=(snapshot,options)=>{f.lastOptions=options;return {text:`Relatório sintético ${options.reportDate}. Dados ${options.dataState}.`,metadata:{provider:'deterministic'},alertCandidates:f.candidates};};
  const make=()=>new ReportScheduler({config,store,actual:f.actual,now:()=>clock,...(!real?{buildReport:mock}:{})});
  f.scheduler=make();
  f.enableDaily=(patch={})=>f.scheduler.preferences.update({...patch,dailyEnabled:true},identity);
  f.enableAlerts=()=>f.scheduler.preferences.update({alertsEnabled:true},identity);
  f.run=async()=>{const job=store.claimJob();if(!job)return null;await f.scheduler.runJob(job);return job;};
  f.scan=async()=>{clock=Math.floor(clock/ALERT_INTERVAL_MS)*ALERT_INTERVAL_MS+ALERT_INTERVAL_MS;f.scheduler.tick();await f.run();};
  f.reopen=()=>{store.close();store=new StateStore(filename,identity,{now:()=>clock});store.recover();f.scheduler=make();};
  f.outbox=()=>store.db.prepare('SELECT * FROM outbox ORDER BY created_at,rowid').all().map(row=>({...row,payload:row.payload?JSON.parse(row.payload):null}));
  return f;
}
const code=expected=>error=>error instanceof AppError&&error.code===expected;
const candidate=(severity,reset={warning:false,critical:false},overrides={})=>({type:'budget',targetId:'food',competence:'2026-09',severity,reset,text:'Categoria sintética; confira no Actual.',...overrides});

test('subscriptions default off; explicit preferences are validated and same assignment is idempotent',async t=>{
  const f=fixture(t),p=f.scheduler.preferences;
  assert.equal(p.get().dailyEnabled,false);assert.equal(p.get().alertsEnabled,false);assert.deepEqual(f.scheduler.tick(),[]);assert.equal(f.reads,0);
  for(const args of [['fuso','Invalid/Zone'],['dias','1,1'],['dias','8'],['horario','24:00'],['detalhe','raw'],['orcamento','100','80','5'],['anomalia','0','3','3'],['saldo','../secret','1000'],['relatorio','sim']])assert.throws(()=>p.command(args,f.identity),code('INPUT_INVALID'));
  const enabled=p.command(['relatorio','ativar'],f.identity);f.at(f.now+1000);assert.deepEqual(p.command(['relatorio','ativar'],f.identity),enabled);
  assert.throws(()=>p.command(['alertas','ativar'],{...f.identity,userId:9}),code('UNAUTHORIZED'));
  const days=p.command(['dias','dom,seg'],f.identity);assert.deepEqual(p.command(['dias','seg,dom'],f.identity),days);
  p.command(['saldo','checking','1000'],f.identity);const limits=p.command(['saldo','card','2000'],f.identity);
  assert.deepEqual(p.command(['saldo','checking','1000'],f.identity),limits,'account order is not a policy change');
});

test('daily occurrence and job are atomic and no occurrence predates subscription',async t=>{
  const f=fixture(t);f.enableDaily({time:'06:00'});assert.deepEqual(f.scheduler.tick(),[]);
  f.at('2026-09-16T09:00:00Z');
  const enqueue=f.store.enqueueJob;f.store.enqueueJob=()=>{throw new AppError('STORAGE_FAILED');};
  assert.throws(()=>f.scheduler.tick(),code('STORAGE_FAILED'));assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM report_occurrences').get().n,0);
  f.store.enqueueJob=enqueue;const slots=f.scheduler.tick();assert.equal(slots.length,1);assert.equal(f.scheduler.tick().length,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,1);
});

test('fold uses first instant once; gap moves to first valid minute and skipped day has none',()=>{
  assert.equal(new Date(resolveCivilTime('2026-11-01','01:30','America/New_York').instant).toISOString(),'2026-11-01T05:30:00.000Z');
  const gap=resolveCivilTime('2026-03-08','02:30','America/New_York');assert.equal(new Date(gap.instant).toISOString(),'2026-03-08T07:00:00.000Z');assert.equal(gap.effectiveTime,'03:00');assert.equal(gap.shifted,true);
  assert.equal(resolveCivilTime('2011-12-30','08:00','Pacific/Apia'),null);
});

test('DST fold delivery, preference edits and reenable never duplicate a reserved civil date',async t=>{
  const f=fixture(t,{at:'2026-10-31T12:00:00Z'});f.enableDaily({timezone:'America/New_York',time:'01:30'});
  f.at('2026-11-01T05:30:00Z');f.scheduler.tick();await f.run();assert.equal(f.outbox().length,1);
  f.at('2026-11-01T06:30:00Z');assert.equal(f.scheduler.tick().length,0);
  f.scheduler.preferences.update({detail:'detailed'},f.identity);assert.equal(f.scheduler.tick().length,0);
  f.scheduler.preferences.update({dailyEnabled:false},f.identity);f.scheduler.preferences.update({time:'03:00',dailyEnabled:true},f.identity);
  f.at('2026-11-01T08:00:00Z');assert.equal(f.scheduler.tick().length,0);
});

test('scheduled timezone is separate from financial date at month boundary',async t=>{
  const f=fixture(t,{at:'2026-08-31T12:00:00Z'});f.enableDaily({timezone:'Asia/Tokyo',time:'08:00'});
  f.at('2026-08-31T23:05:00Z');f.scheduler.tick();await f.run();
  const row=f.store.db.prepare('SELECT * FROM report_occurrences').get();assert.equal(row.slot_key,'2026-09-01');assert.equal(row.report_date,'2026-08-31');assert.equal(f.lastOptions.reportDate,'2026-08-31');assert.match(f.outbox()[0].payload.text,/data financeira 2026-08-31/);
});

test('restart coalesces old queued work before consumer RPC and keeps only latest missed daily occurrence',async t=>{
  const f=fixture(t,{persistent:true});f.enableDaily();f.at('2026-09-15T11:01:00Z');f.scheduler.tick();
  f.at('2026-09-18T12:00:00Z');f.reopen();
  await f.run();assert.equal(f.reads,0,'old claimed job is cancelled before SDK read');await f.run();
  assert.equal(f.reads,1);const rows=f.store.db.prepare('SELECT report_date,state FROM report_occurrences ORDER BY scheduled_at').all();
  assert.deepEqual(rows,[{report_date:'2026-09-15',state:'cancelled'},{report_date:'2026-09-18',state:'completed'}]);assert.equal(f.outbox().length,1);
});

test('clock rollback respects high watermark even for dates never individually materialized',async t=>{
  const f=fixture(t);f.enableDaily();f.at('2026-09-20T12:00:00Z');f.scheduler.tick();await f.run();
  f.at('2026-09-17T12:00:00Z');assert.equal(f.scheduler.tick().length,0);f.at('2026-09-20T12:30:00Z');assert.equal(f.scheduler.tick().length,0);
  f.store.prune(1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM report_occurrences').get().n,1);
});

test('daily backlog supersedes unsent older output but preserves uncertain delivery',async t=>{
  const f=fixture(t);f.enableDaily();f.at('2026-09-15T11:00:00Z');f.scheduler.tick();await f.run();
  const first=f.outbox()[0];f.at('2026-09-16T11:00:00Z');f.scheduler.tick();assert.equal(f.outbox().find(r=>r.id===first.id).state,'failed');await f.run();
  const second=f.store.claimOutbox();f.store.finishOutbox(second.id,{state:'uncertain',code:'DELIVERY_UNCERTAIN'});
  f.at('2026-09-17T11:00:00Z');f.scheduler.tick();assert.equal(f.outbox().find(r=>r.id===second.id).state,'uncertain');
});

test('opt-out cancels queued jobs and pending deliveries and rechecks during slow read',async t=>{
  const f=fixture(t);f.enableDaily();f.at('2026-09-15T11:00:00Z');f.scheduler.tick();f.scheduler.preferences.update({dailyEnabled:false},f.identity);
  assert.equal(f.store.claimJob(),null);assert.equal(f.reads,0);
  f.at('2026-09-16T10:00:00Z');f.enableDaily();f.at('2026-09-16T11:00:00Z');f.scheduler.tick();
  f.onRead=()=>f.scheduler.preferences.update({dailyEnabled:false},f.identity);await f.run();assert.equal(f.outbox().length,0);
});

test('latest alert interval only catches up and no slot earlier than subscription is reserved',async t=>{
  const f=fixture(t,{persistent:true});f.enableAlerts();assert.equal(f.scheduler.tick().length,0);
  f.at('2026-09-17T14:47:00Z');f.reopen();f.scheduler.tick();await f.run();
  const row=f.store.db.prepare('SELECT * FROM report_occurrences').get();assert.equal(new Date(row.scheduled_at).toISOString(),'2026-09-17T14:45:00.000Z');assert.equal(f.reads,1);assert.equal(f.scheduler.tick().length,0);
});

test('alert hysteresis notifies activation/escalation/reentry with stable episodes and ignores repeated severity',async t=>{
  const f=fixture(t);f.enableAlerts();f.candidates=[candidate('warning')];await f.scan();assert.equal(f.outbox().length,1);
  await f.scan();assert.equal(f.outbox().length,1);
  f.candidates=[candidate('none',{warning:false,critical:true})];await f.scan();assert.equal(f.store.db.prepare('SELECT severity FROM alert_state').get().severity,'warning');
  f.candidates=[candidate('critical')];await f.scan();assert.equal(f.outbox().length,2);
  f.candidates=[candidate('warning',{warning:false,critical:true})];await f.scan();assert.equal(f.outbox().length,2);
  f.candidates=[candidate('critical')];await f.scan();assert.equal(f.outbox().length,3);
  f.candidates=[candidate('none',{warning:true,critical:true})];await f.scan();f.candidates=[candidate('warning')];await f.scan();
  assert.equal(f.outbox().length,4);assert.equal(f.store.db.prepare('SELECT episode FROM alert_state').get().episode,2);
  assert.match(f.outbox().at(-1).payload.text,/Fonte: Actual; snapshot/);assert.match(f.outbox().at(-1).payload.text,/sincronizado/);
});

test('resolved or escalated pending/rate-limited alert is cancelled before send; uncertain history is preserved',async t=>{
  const f=fixture(t);f.enableAlerts();f.candidates=[candidate('warning')];await f.scan();
  await processOneDelivery({store:f.store,scheduler:f.scheduler,telegram:{sendMessage:async()=>{throw new AppError('TELEGRAM_RATE_LIMITED',{retryAfterSeconds:3600});}},logger:()=>{}});
  assert.equal(f.outbox()[0].state,'pending');f.candidates=[candidate('none',{warning:true,critical:true})];await f.scan();assert.equal(f.outbox()[0].state,'failed');
  f.candidates=[candidate('warning')];await f.scan();f.at(f.now+3600000);
  await processOneDelivery({store:f.store,scheduler:f.scheduler,telegram:{sendMessage:async()=>{throw new Error('TOKEN_CANARY');}},logger:()=>{}});
  const uncertain=f.outbox().find(r=>r.state==='uncertain');assert.ok(uncertain);
  f.candidates=[candidate('none',{warning:true,critical:true})];await f.scan();assert.equal(f.outbox().find(r=>r.id===uncertain.id).state,'uncertain');
});

test('outbox guard rejects stale transition even if delivery cancellation marker was not set',async t=>{
  const f=fixture(t);f.enableAlerts();f.candidates=[candidate('warning')];await f.scan();
  const row=f.store.claimOutbox();f.store.db.prepare("UPDATE alert_state SET severity='none',transition_index=transition_index+1").run();assert.equal(f.scheduler.authorizeDelivery(row),false);
});

test('Actual down, incomplete and stale reads never advance or resolve alert state',async t=>{
  const f=fixture(t);f.enableAlerts();f.candidates=[candidate('warning')];await f.scan();const state=f.store.db.prepare('SELECT * FROM alert_state').get();
  f.candidates=[candidate('none',{warning:true,critical:true})];f.readError=new AppError('ACTUAL_TIMEOUT');await f.scan();assert.deepEqual(f.store.db.prepare('SELECT * FROM alert_state').get(),state);assert.equal(f.outbox().length,1);
  f.readError=null;f.changeSnapshot=s=>{s.coverage.complete=false;s.coverage.failedAccountIds=['checking'];};await f.scan();assert.deepEqual(f.store.db.prepare('SELECT * FROM alert_state').get(),state);
});

test('compatible report fallback is explicitly stale; different scope/date/identity/normalization cannot supply it',async t=>{
  const f=fixture(t);const fresh=await f.scheduler.manualReport(f.identity);assert.match(fresh.text,/fresh/);f.readError=new AppError('ACTUAL_TIMEOUT');
  assert.match((await f.scheduler.manualReport(f.identity)).text,/stale/);
  f.store.setPreference('finance_scope',{includeClosed:true,includeOffBudget:false});assert.match((await f.scheduler.manualReport(f.identity)).text,/sem snapshot compatível/);
  f.store.setPreference('finance_scope',{includeClosed:false,includeOffBudget:false});f.at('2026-09-16T12:00:00Z');assert.match((await f.scheduler.manualReport(f.identity)).text,/sem snapshot compatível/);
  f.at('2026-09-15T12:00:00Z');f.store.db.prepare("UPDATE snapshots SET payload=json_set(payload,'$.rulesVersion','wrong')").run();assert.match((await f.scheduler.manualReport(f.identity)).text,/sem snapshot compatível/);
});

test('SQLite persistence errors remain storage failures and do not masquerade as integration fallback',async t=>{
  const f=fixture(t);await f.scheduler.manualReport(f.identity);
  f.store.saveSnapshot=()=>{throw new AppError('STORAGE_FAILED');};await assert.rejects(f.scheduler.manualReport(f.identity),code('STORAGE_FAILED'));
});

test('result, transition, outbox and completion are atomic and recovered read replay creates one result',async t=>{
  const f=fixture(t);f.enableAlerts();f.candidates=[candidate('warning')];f.at(f.now+ALERT_INTERVAL_MS);f.scheduler.tick();
  const complete=f.store.completeJob;f.store.completeJob=()=>{throw new AppError('STORAGE_FAILED');};await assert.rejects(f.run(),code('STORAGE_FAILED'));
  assert.equal(f.outbox().length,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM alert_state').get().n,0);assert.equal(f.store.db.prepare('SELECT state FROM report_occurrences').get().state,'pending');
  f.store.completeJob=complete;f.store.recover();await f.run();assert.equal(f.outbox().length,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM alert_transitions').get().n,1);
});

test('cap20 keeps overflowing active candidates unadvanced for a fresh later scan',async t=>{
  const f=fixture(t);f.enableAlerts();f.candidates=Array.from({length:23},(_,i)=>candidate('warning',undefined,{targetId:`cat${i}`}));
  await f.scan();assert.equal(f.outbox().length,20);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM alert_state').get().n,20);
  await f.scan();assert.equal(f.outbox().length,23);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM alert_state').get().n,23);
});

test('preferences and manual report commands use no model; account typos do not create silent limits',async t=>{
  const f=fixture(t,{real:true}),handler=createCommandHandler({config:f.config,store:f.store,actual:f.actual,reportScheduler:f.scheduler,intentClient:{interpret:()=>{throw new Error('MODEL_MUST_NOT_RUN');}}});
  const request=text=>({type:'message',text,identity:f.identity});
  assert.match((await handler(request('/preferencias'))).text,/desativado/);
  assert.match((await handler(request('/preferencias saldo typo 10000'))).text,/não encontrada/);assert.equal(f.scheduler.preferences.get().thresholds.lowBalances.length,0);
  await handler(request('/preferencias saldo checking 10000'));assert.equal(f.scheduler.preferences.get().thresholds.lowBalances[0].accountId,'checking');
  const report=await handler(request('/relatorio'));assert.match(report.text,/Actual/);assert.match(report.text,/Provedor: regras locais/);assert.equal(f.scheduler.preferences.get().dailyEnabled,false);assert.equal(f.outbox().length,0);
});

test('runtime recognizes scheduled jobs and does not issue an error after their durable completion',async t=>{
  const f=fixture(t);f.enableDaily();f.at('2026-09-15T11:00:00Z');f.scheduler.tick();const original=f.scheduler.runJob.bind(f.scheduler);
  f.scheduler.runJob=async job=>{await original(job);throw new Error('AFTER_COMMIT');};
  await processOneJob({store:f.store,scheduler:f.scheduler,handler:()=>{throw new Error('WRONG_HANDLER');},telegram:{},logger:()=>{throw new Error('UNEXPECTED_LOG');}});
  assert.equal(f.outbox().length,1);assert.equal(f.store.db.prepare('SELECT state FROM jobs').get().state,'done');
});

test('opt-out during rejected SDK read produces no generic unguarded failure delivery',async t=>{
  const f=fixture(t);f.enableDaily();f.at('2026-09-15T11:00:00Z');f.scheduler.tick();
  f.onRead=()=>{f.scheduler.preferences.update({dailyEnabled:false},f.identity);throw new AppError('SNAPSHOT_INVALID');};
  await processOneJob({store:f.store,scheduler:f.scheduler,logger:()=>{}});
  assert.equal(f.outbox().length,0);assert.equal(f.store.db.prepare('SELECT state FROM report_occurrences').get().state,'cancelled');
  assert.deepEqual(f.store.db.prepare('SELECT state,error_code FROM jobs').get(),{state:'done',error_code:'SNAPSHOT_INVALID'});
});

test('authorized scheduled failure is policy-bound and can be cancelled before delivery',async t=>{
  const f=fixture(t);f.enableDaily();f.at('2026-09-15T11:00:00Z');f.scheduler.tick();f.readError=new AppError('SNAPSHOT_INVALID');
  await processOneJob({store:f.store,scheduler:f.scheduler,logger:()=>{}});
  assert.equal(f.outbox().length,1);assert.match(f.outbox()[0].payload.text,/SNAPSHOT_INVALID/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM report_deliveries').get().n,1);
  f.scheduler.preferences.update({dailyEnabled:false},f.identity);let sends=0;
  await processOneDelivery({store:f.store,scheduler:f.scheduler,telegram:{sendMessage:async()=>sends++},logger:()=>{}});assert.equal(sends,0);
});

test('delivery before first restart tick cannot send an older missed daily report',async t=>{
  const f=fixture(t,{persistent:true});f.enableDaily();f.at('2026-09-15T11:00:00Z');f.scheduler.tick();await f.run();
  f.at('2026-09-18T12:00:00Z');f.reopen();let sends=0;
  await processOneDelivery({store:f.store,scheduler:f.scheduler,telegram:{sendMessage:async()=>sends++},logger:()=>{}});
  assert.equal(sends,0);assert.equal(f.outbox()[0].state,'failed');await f.run();assert.equal(f.reads,2);
});

test('a newer slot arriving during read supersedes the current result before commit',async t=>{
  const f=fixture(t);f.enableDaily();f.at('2026-09-15T11:00:00Z');f.scheduler.tick();
  f.onRead=()=>f.at('2026-09-16T11:00:00Z');await f.run();assert.equal(f.outbox().length,0);
  f.onRead=null;await f.run();assert.equal(f.outbox().length,1);assert.match(f.outbox()[0].payload.text,/2026-09-16/);
});

test('real-domain budget alerts re-evaluate thresholds and preserve daily occurrence dedupe',async t=>{
  const f=fixture(t,{real:true});f.enableDaily();f.enableAlerts();
  f.changeSnapshot=s=>{s.budgetMonths[0].categories=s.budgetMonths[0].categories.filter(c=>c.id==='food');s.budgetMonths[0].categories[0].spent=-8500;s.budgetMonths[0].categories[0].balance=1500;};
  f.at('2026-09-15T11:00:00Z');f.scheduler.tick();await f.run();await f.run();
  assert.equal(f.store.db.prepare("SELECT severity FROM alert_state WHERE type='budget'").get().severity,'warning');
  const dailyCount=f.store.db.prepare("SELECT COUNT(*) n FROM report_occurrences WHERE kind='daily'").get().n;
  f.scheduler.preferences.command(['orcamento','90','100','5'],f.identity);await f.scan();
  assert.equal(f.store.db.prepare("SELECT severity FROM alert_state WHERE type='budget'").get().severity,'warning','exact reset threshold holds');
  f.changeSnapshot=s=>{s.budgetMonths[0].categories=s.budgetMonths[0].categories.filter(c=>c.id==='food');s.budgetMonths[0].categories[0].spent=-8400;s.budgetMonths[0].categories[0].balance=1600;};await f.scan();
  assert.equal(f.store.db.prepare("SELECT severity FROM alert_state WHERE type='budget'").get().severity,'none');assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM report_occurrences WHERE kind='daily'").get().n,dailyCount);
});

test('real-domain explicit low balance respects null, zero, hysteresis and eligible scope',async t=>{
  const f=fixture(t,{real:true});f.enableAlerts();f.scheduler.preferences.command(['saldo','checking','10000'],f.identity);
  let balance=0;f.changeSnapshot=s=>{s.budgetMonths=[];s.accounts.find(a=>a.id==='checking').balance=balance;};await f.scan();
  assert.equal(f.store.db.prepare("SELECT severity FROM alert_state WHERE type='low_balance'").get().severity,'warning');const first=f.store.db.prepare('SELECT * FROM alert_state').get();
  balance=null;await f.scan();assert.deepEqual(f.store.db.prepare('SELECT * FROM alert_state').get(),first,'unknown is not zero or recovery');
  balance=10500;await f.scan();assert.equal(f.store.db.prepare('SELECT severity FROM alert_state').get().severity,'warning');
  balance=11000;await f.scan();assert.equal(f.store.db.prepare('SELECT severity FROM alert_state').get().severity,'none');
  f.scheduler.preferences.command(['saldo','off','60000'],f.identity);await f.scan();assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM alert_state WHERE target_id='off'").get().n,0);
  f.store.transaction(()=>{f.store.setPreference('finance_scope',{includeClosed:false,includeOffBudget:true});f.scheduler.preferences.scopeChanged();});await f.scan();
  assert.equal(f.store.db.prepare("SELECT severity FROM alert_state WHERE target_id='off'").get().severity,'warning');
});

test('real-domain retroactive anomaly edits, recovery and out-of-window absence retain correct state',async t=>{
  const f=fixture(t,{real:true});f.enableAlerts();let amount=-1000,removed=false;
  f.changeSnapshot=s=>{
    s.budgetMonths=[];const base=financialSnapshot().transactions[0];
    s.transactions=Array.from({length:8},(_,i)=>({...base,id:`base-${i}`,date:`2026-08-${String(i+1).padStart(2,'0')}`,amount:-1000}));
    if(!removed)s.transactions.push({...base,id:'retro-target',date:'2026-09-14',amount});
    s.transactions=s.transactions.filter(r=>r.date>=s.period.start&&r.date<=s.period.end);
  };
  await f.scan();assert.equal(f.outbox().length,0);amount=-12000;await f.scan();
  assert.equal(f.outbox().length,1);assert.match(f.outbox()[0].payload.text,/2026-09-14/);await f.scan();assert.equal(f.outbox().length,1);
  amount=-5400;await f.scan();assert.equal(f.store.db.prepare("SELECT severity FROM alert_state WHERE target_id='retro-target'").get().severity,'none');
  amount=-12000;await f.scan();assert.equal(f.store.db.prepare("SELECT episode FROM alert_state WHERE target_id='retro-target'").get().episode,2);
  removed=true;f.at('2027-10-15T12:00:00Z');f.scheduler.tick();await f.run();
  assert.equal(f.store.db.prepare("SELECT severity FROM alert_state WHERE target_id='retro-target'").get().severity,'warning','absence outside complete coverage proves nothing');
});

test('report retention minimizes uncertain text while preserving dedupe and unrelated operation output',async t=>{
  const f=fixture(t);f.enableAlerts();f.candidates=[candidate('warning')];await f.scan();
  const row=f.store.claimOutbox();f.store.finishOutbox(row.id,{state:'uncertain',code:'DELIVERY_UNCERTAIN'});
  const other=f.store.enqueueOutbox({text:'Operação incerta preservada',dedupeKey:'unrelated-operation'});
  f.store.db.prepare("UPDATE outbox SET state='uncertain' WHERE id=?").run(other);
  f.at(f.now+2*86400000);f.scheduler.repository.prune(1);
  assert.equal(f.outbox().find(r=>r.id===row.id).payload,null);assert.equal(f.outbox().find(r=>r.id===row.id).state,'uncertain');
  assert.ok(f.outbox().find(r=>r.id===other).payload);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM alert_state').get().n,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM report_occurrences').get().n,1);
  await f.scan();let sends=0;
  await processOneDelivery({store:f.store,scheduler:f.scheduler,telegram:{sendMessage:async()=>sends++},logger:()=>{}});
  assert.equal(sends,0);assert.equal(f.outbox().length,2,'the same condition is not re-enqueued after pruning');
});
