import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FinanceTools, FINANCE_TOOL_DEFINITIONS } from '../src/application/assistant-tools.mjs';
import { AssistantActions, recoverAssistantActions, pruneAssistantActions } from '../src/application/assistant-actions.mjs';
import { CategorizationActions } from '../src/application/actions.mjs';
import { transactionFingerprint } from '../src/actual/transaction.mjs';
import { categoryFingerprint } from '../src/actual/category.mjs';
import { StateStore } from '../src/storage/store.mjs';
import { validateConfig } from '../src/config.mjs';
import { identityFromConfig } from '../src/policy/authorize.mjs';
import { AppError } from '../src/errors.mjs';
import { inputConfig } from './helpers.mjs';
import { financialSnapshot } from './fixtures/financial.mjs';
const ref=(kind,operationId)=>({id:randomUUID(),kind,operationId,sha256:'a'.repeat(64),bytes:512,createdAt:'2026-09-15T12:00:00Z'});
function fixture(t,{dryRun=false}={}) {
  const config=validateConfig({...inputConfig(),dryRun,backup:{keyRef:'backup-key'}}),identity=identityFromConfig(config),context={householdId:identity.householdId,budgetId:identity.budgetId};
  let time=Date.parse('2026-09-15T12:00:00Z');const store=new StateStore(':memory:',identity,{now:()=>time});t.after(()=>store.close());
  const base=financialSnapshot(),template=base.transactions.find(row=>row.id==='uncategorized');
  const f={config,identity,context,store,rows:[{...template,id:'t1'},{...template,id:'t2'}],categories:base.categories,groups:[{id:'expenses',name:'Despesas',isIncome:false,hidden:false}],calls:[],setTime:value=>{time=value;}};
  f.categories.forEach(row=>{row.groupId='expenses';});
  const actual={
    snapshot:async period=>{f.calls.push('snapshot');return {...base,period,syncedAt:new Date(time).toISOString(),transactions:f.rows.filter(row=>row.date>=period.start&&row.date<=period.end),categories:f.categories,categoryGroups:f.groups,coverage:{complete:!f.incomplete,failedAccountIds:f.incomplete?['checking']:[]}};},
    inspectCategoryCatalog:async()=>{f.calls.push('catalog');return {context,categories:structuredClone(f.categories),groups:structuredClone(f.groups),syncedAt:new Date(time).toISOString()};},
    inspectTransaction:async id=>{f.calls.push('inspect:'+id);const row=f.rows.find(row=>row.id===id);if(!row)throw Error('missing synthetic target');return {context,transaction:structuredClone(row),account:base.accounts[0],payee:base.payees[0],categories:structuredClone(f.categories),categoryGroups:structuredClone(f.groups),eligibility:{eligible:!row.isChild},fingerprint:transactionFingerprint(context,row)};},
    createCategory:async args=>{f.calls.push('create');const category={id:'created',name:args.name,groupId:args.groupId,isIncome:args.expectedGroup.isIncome,hidden:false};f.categories.push(category);if(f.createUncertain)return {status:'uncertain',code:'MUTATION_UNCERTAIN',backupRef:ref('actual',args.operationId)};return {status:'applied',code:null,category,categoryFingerprint:categoryFingerprint(context,category),backupRef:ref('actual',args.operationId),verifiedAt:new Date(time).toISOString()};},
    changeCategory:async args=>{f.calls.push('patch:'+args.targetId);const row=f.rows.find(row=>row.id===args.targetId),before=structuredClone(row);if(f.failTarget===row.id)return {status:'failed_before',code:'BACKUP_FAILED'};row.categoryId=args.categoryId;await f.afterPatch?.(row);return {status:f.uncertainTarget===row.id?'uncertain':'applied',code:f.uncertainTarget===row.id?'MUTATION_UNCERTAIN':null,before,after:structuredClone(row),beforeFingerprint:transactionFingerprint(context,before),afterFingerprint:transactionFingerprint(context,row),backupRef:ref('actual',args.operationId),verifiedAt:new Date(time).toISOString()};}
  };
  const backup=async(_store,args)=>{f.calls.push('backup-state');await f.afterBackup?.();if(f.backupFails)throw Error('SECRET_CANARY');return ref('state',args.operationId);};
  const actions=new AssistantActions({config,store,actual,backupStateImpl:backup});
  Object.assign(f,{actual,actions,tools:new FinanceTools({config,store,actual,actions,now:()=>new Date(time)}),single:new CategorizationActions({config,store,actual,backupStateImpl:backup}),request:text=>({type:'message',text,identity})});
  f.job=request=>{const id=store.enqueueJob({kind:'command',dedupeKey:randomUUID(),payload:request??f.request('/status')});const job=store.claimJob();assert.equal(job.id,id);return job;};
  f.prepare=async input=>{const job=f.job(),result=await actions.prepare(input,{identity,job,allowedTransactionIds:new Set(f.rows.map(row=>row.id))});store.completeJob(job.id);return result;};
  f.confirm=async result=>{const data=result.message.replyMarkup.inline_keyboard[0][0].callback_data,request={type:'callback',data,identity},job=f.job(request);const response=await actions.handle(request,job);store.completeJob(job.id,response);return response;};
  f.latest=()=>store.db.prepare('SELECT * FROM assistant_action_operations ORDER BY rowid DESC LIMIT 1').get();
  return f;
}
const batch=(categoryId='food')=>({changes:[{transactionId:'t1',categoryId},{transactionId:'t2',categoryId}]});
test('assistant tools search future existing notes with literal wildcard safely; pagination stays bounded and complete',async t=>{
  const f=fixture(t);f.rows=Array.from({length:13},(_,i)=>({...f.rows[0],id:'future'+i,date:'2026-10-01',notes:'Energia * apartamento [a-z] '+i}));
  const request={identity:f.identity},args={text:'ENERGIA*apartamento [a-z]',start:'2026-09-01',end:'2026-11-01',pageSize:10};
  const first=await f.tools.execute('search_transactions',args,request),next=await f.tools.execute('search_transactions',{...args,page:2},request);
  assert.equal(first.data.complete,true);assert.equal(first.data.total,13);assert.equal(first.data.transactions.length,10);assert.equal(next.data.transactions.length,3);assert.equal(first.data.transactions[0].date,'2026-10-01');assert.equal(first.data.transactions[0].amountCents,-3000);
  assert.doesNotMatch(JSON.stringify(first.data),/balance|netExpenses/);
  await assert.rejects(f.tools.execute('search_transactions',{...args,pageSize:11},request),{code:'INPUT_INVALID'});
  await assert.rejects(f.tools.execute('search_transactions',{...args,start:'2023-01-01'},request),{code:'INPUT_INVALID'});
  f.incomplete=true;await assert.rejects(f.tools.execute('search_transactions',args,request),{code:'SNAPSHOT_INVALID'});
});
test('categories can be refined beyond40items and groups remain separately paginated',async t=>{
  const f=fixture(t);f.categories=Array.from({length:60},(_,i)=>({id:'category'+i,name:i===59?'Energia elétrica':'Outra '+i,groupId:'expenses',isIncome:false,hidden:false}));
  f.groups.push(...Array.from({length:25},(_,i)=>({id:'g'+i,name:'Grupo '+i,isIncome:false,hidden:false})));
  const response=await f.tools.execute('list_categories',{text:'ELETRICA'}, {identity:f.identity});assert.equal(response.data.total,1);assert.equal(response.data.categories[0].id,'category59');assert.equal(response.data.groups.length,10);assert.equal(response.data.groupsTruncated,true);
  const grouped=await f.tools.execute('list_categories',{groupText:'DESPESAS'}, {identity:f.identity});assert.equal(grouped.data.totalGroups,1);assert.equal(grouped.data.groups[0].id,'expenses');
});
test('query_finances allows existing reads only and returns observed uncategorized IDs',async t=>{
  const f=fixture(t),request={identity:f.identity};
  const response=await f.tools.execute('query_finances',{command:'/sem_categoria'},request);assert.deepEqual(response.data.selection.transactions.map(row=>row.id),['t1','t2']);assert.equal(response.data.selection.eligible,true);
  const snapshot=f.actual.snapshot;f.actual.snapshot=async()=>{throw new AppError('ACTUAL_TIMEOUT');};
  const stale=await f.tools.execute('query_finances',{command:'/sem_categoria'},request);assert.equal(stale.data.selection.clear,true);assert.equal(stale.data.selection.eligible,false);assert.equal(stale.data.selection.dataState,'stale');assert.deepEqual(stale.data.selection.transactions,[]);f.actual.snapshot=snapshot;
  for(const command of ['/confirmar token','/escopo todas','/gastos 2026-09-01 2026-10-01'])await assert.rejects(f.tools.execute('query_finances',{command},request),{code:'INPUT_INVALID'});
  assert.equal(FINANCE_TOOL_DEFINITIONS.some(tool=>/confirm|execute|delete/i.test(tool.name)),false);
});
test('proposal is one per job and never writes; only observed targets are accepted',async t=>{
  const f=fixture(t),job=f.job();
  await assert.rejects(f.actions.prepare(batch(),{identity:f.identity,job,allowedTransactionIds:['t1']}),{code:'MUTATION_TARGET_MISSING'});
  const request={identity:f.identity,job,allowedTransactionIds:['t1','t2']},first=await f.actions.prepare(batch(),request),again=await f.actions.prepare(batch(),request);
  assert.deepEqual(again,first);assert.match(first.message.text,/somente a categoria/);assert.match(first.message.text,/30,00/);assert.equal(f.calls.some(x=>x==='create'||x.startsWith('patch')||x==='backup-state'),false);
  await assert.rejects(f.actions.prepare(batch('transport'),request),{code:'PROPOSAL_USED'});f.store.completeJob(job.id);
  await assert.rejects(f.actions.handle({type:'callback',data:first.message.replyMarkup.inline_keyboard[0][0].callback_data,identity:{...f.identity,userId:999}},null),{code:'UNAUTHORIZED'});
});
test('confirmed real batch validates all items, backs up, applies once and delivers an authoritative result',async t=>{
  const f=fixture(t),p=await f.prepare(batch()),response=await f.confirm(p);
  assert.equal(f.latest().state,'applied');assert.deepEqual(f.rows.map(row=>row.categoryId),['food','food']);assert.match(response.text,/aplicado e conferido/);
  assert.ok(f.calls.indexOf('inspect:t2')<f.calls.indexOf('backup-state'));assert.ok(f.calls.indexOf('backup-state')<f.calls.indexOf('patch:t1'));
  assert.equal(f.calls.filter(x=>x==='patch:t1').length,1);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE dedupe_key LIKE 'assistant-operation-result:%'").get().n,1);
  await assert.rejects(f.confirm(p),{code:'PROPOSAL_USED'});
});
test('dry-run category creation and batch do not export or mutate anything',async t=>{
  const f=fixture(t,{dryRun:true}),p=await f.prepare({...batch('$new'),newCategory:{name:' Energia ',groupId:'expenses'}});await f.confirm(p);
  assert.equal(f.latest().state,'simulated');assert.equal(f.calls.some(x=>x==='create'||x.startsWith('patch')||x==='backup-state'),false);assert.equal(f.categories.some(row=>row.id==='created'),false);
});
test('all fingerprints and catalog prerequisites are rechecked before first mutation, including after state backup',async t=>{
  for(const change of ['before','duringBackup','hiddenGroup']){
    const f=fixture(t),p=await f.prepare({...batch('$new'),newCategory:{name:'Energia',groupId:'expenses'}});
    if(change==='before')f.rows[1].amount--;
    if(change==='duringBackup')f.afterBackup=()=>{f.rows[1].notes='changed';};
    if(change==='hiddenGroup')f.groups[0].hidden=true;
    await f.confirm(p);assert.equal(f.latest().state,'failed_before');assert.equal(f.calls.some(x=>x==='create'||x.startsWith('patch')),false);
  }
});
test('creation is verified before resolving $new; partial or uncertain batches never replay remaining items',async t=>{
  for(const scenario of ['success','uncertainCreate','partialItem','uncertainItem','changedNext']){
    const f=fixture(t),p=await f.prepare({...batch('$new'),newCategory:{name:'Energia',groupId:'expenses'}});
    f.createUncertain=scenario==='uncertainCreate';f.failTarget=scenario==='partialItem'?'t2':null;f.uncertainTarget=scenario==='uncertainItem'?'t1':null;
    if(scenario==='changedNext')f.afterPatch=row=>{if(row.id==='t1')f.rows[1].notes='changed after first write';};
    const response=await f.confirm(p),result=JSON.parse(f.latest().result_json);
    assert.equal(f.calls.filter(x=>x==='create').length,1);
    if(scenario==='success'){assert.equal(f.latest().state,'applied');assert.deepEqual(f.rows.map(row=>row.categoryId),['created','created']);}
    if(scenario==='uncertainCreate'){assert.equal(f.latest().state,'uncertain');assert.equal(f.calls.some(x=>x.startsWith('patch')),false);assert.equal(result.creation.state,'uncertain');}
    if(scenario==='partialItem'||scenario==='changedNext'){assert.equal(f.latest().state,'partial');assert.equal(result.creation.state,'applied');assert.equal(result.items[0].state,'applied');assert.match(response.text,/mantidas/);}
    if(scenario==='uncertainItem'){assert.equal(f.latest().state,'uncertain');assert.equal(f.calls.includes('patch:t2'),false);}
    const before=f.calls.length;recoverAssistantActions(f.store);recoverAssistantActions(f.store);assert.equal(f.calls.length,before);
  }
});
test('expired and cancelled proposals cannot consume a new write',async t=>{
  const f=fixture(t),p=await f.prepare(batch()),nonce=p.message.replyMarkup.inline_keyboard[0][0].callback_data.slice(3);
  await f.actions.handle(f.request('/cancelar_lote '+nonce),null);await assert.rejects(f.confirm(p),{code:'PROPOSAL_USED'});
  // Complete the rejected job before preparing another command in this fixture.
  f.store.db.prepare("UPDATE jobs SET state='done' WHERE state='running'").run();
  const next=await f.prepare(batch());f.setTime(Date.parse('2026-09-15T12:16:00Z'));await assert.rejects(f.confirm(next),{code:'PROPOSAL_EXPIRED'});
  assert.equal(f.calls.some(x=>x.startsWith('patch')),false);
});
test('batch invalidates learned examples, prevents old undo ABA and retains target ownership after pruning',async t=>{
  const f=fixture(t),request=f.request('/categorizar t1 food'),job=f.job(request),proposal=await f.single.prepare('t1','food',{identity:f.identity,job});f.store.completeJob(job.id);
  const nonce=proposal.replyMarkup.inline_keyboard[0][0].callback_data.slice(3),confirmJob=f.job();const old=await f.single.confirm(nonce,{identity:f.identity,job:confirmJob});f.store.completeJob(confirmJob.id,old);
  const oldId=f.single.journal.operations()[0].id;assert.equal(f.single.journal.examples().length,1);
  await f.confirm(await f.prepare({changes:[{transactionId:'t1',categoryId:'transport'}]}));assert.equal(f.single.journal.examples().length,0);
  await f.confirm(await f.prepare({changes:[{transactionId:'t1',categoryId:'food'}]}));
  const undoJob=f.job();await assert.rejects(f.single.undo(oldId,{identity:f.identity,job:undoJob}),{code:'UNDO_UNAVAILABLE'});f.store.completeJob(undoJob.id);
  f.setTime(Date.parse('2027-01-01T00:00:00Z'));pruneAssistantActions(f.store,1);
  assert.notEqual(f.single.journal.latestTargetOperation('t1').id,oldId);
  const status=await f.actions.handle(f.request('/lote'),null);assert.match(status.text,/LOTES RECENTES/);assert.match(status.text,/\/lote/);
});
test('restart marks an inflight item uncertain, keeps committed creation/item evidence, and never calls Actual',async t=>{
  const f=fixture(t),p=await f.prepare({...batch('$new'),newCategory:{name:'Energia',groupId:'expenses'}});await f.confirm(p);
  const op=f.latest(),result=JSON.parse(op.result_json);result.inflight=1;result.items[1].state='pending';
  f.store.db.prepare("UPDATE assistant_action_operations SET state='executing',result_json=? WHERE id=?").run(JSON.stringify(result),op.id);
  const calls=f.calls.length;recoverAssistantActions(f.store);assert.equal(f.calls.length,calls);const recovered=JSON.parse(f.latest().result_json);
  assert.equal(f.latest().state,'uncertain');assert.equal(recovered.creation.state,'applied');assert.equal(recovered.items[0].state,'applied');assert.equal(recovered.items[1].state,'uncertain');
});
test('standalone creation needs confirmation and backup; state backup failure prevents its RPC',async t=>{
  for(const fail of [false,true]){
    const f=fixture(t),p=await f.prepare({changes:[],newCategory:{name:'Energia',groupId:'expenses'}});f.backupFails=fail;
    const response=await f.confirm(p);assert.equal(f.latest().state,fail?'failed_before':'applied');assert.equal(f.calls.filter(x=>x==='create').length,fail?0:1);assert.equal(f.calls.some(x=>x.startsWith('patch')),false);assert.doesNotMatch(response.text,/SECRET_CANARY/);
  }
});
test('policy changes and durable acknowledgment failure leave batch approval unconsumed',async t=>{
  const f=fixture(t),p=await f.prepare(batch()),nonce=p.message.replyMarkup.inline_keyboard[0][0].callback_data.slice(3),job=f.job();
  const changed=new AssistantActions({config:{...f.config,dryRun:true},store:f.store,actual:f.actual});
  await assert.rejects(changed.confirm(nonce,{identity:f.identity,job}),{code:'PROPOSAL_POLICY_CHANGED'});
  const enqueue=f.store.enqueueOutbox;f.store.enqueueOutbox=()=>{throw new AppError('STORAGE_FAILED');};
  await assert.rejects(f.actions.confirm(nonce,{identity:f.identity,job}),{code:'STORAGE_FAILED'});f.store.enqueueOutbox=enqueue;
  assert.equal(f.actions.proposal(nonce,f.identity).state,'pending');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM assistant_action_operations').get().n,0);assert.equal(f.store.db.prepare('SELECT safe_retry FROM jobs WHERE id=?').get(job.id).safe_retry,1);assert.equal(f.calls.some(x=>x.startsWith('patch')),false);
});
test('batch result commit failure recovers once without repeating a successful category creation',async t=>{
  const f=fixture(t),p=await f.prepare({changes:[],newCategory:{name:'Energia',groupId:'expenses'}}),nonce=p.message.replyMarkup.inline_keyboard[0][0].callback_data.slice(3),job=f.job();
  const enqueue=f.store.enqueueOutbox;f.store.enqueueOutbox=function(message){if(message.dedupeKey.startsWith('assistant-operation-result:'))throw new AppError('STORAGE_FAILED');return enqueue.call(this,message);};
  await assert.rejects(f.actions.confirm(nonce,{identity:f.identity,job}),{code:'STORAGE_FAILED'});assert.equal(f.latest().state,'executing');assert.equal(f.calls.filter(x=>x==='create').length,1);
  f.store.enqueueOutbox=enqueue;recoverAssistantActions(f.store);recoverAssistantActions(f.store);assert.equal(f.latest().state,'uncertain');assert.equal(f.calls.filter(x=>x==='create').length,1);assert.equal(JSON.parse(f.latest().result_json).creation.state,'applied');
});
