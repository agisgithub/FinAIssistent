import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ActualExecutor } from '../src/actual/executor.mjs';
import { ActualClient } from '../src/actual/client.mjs';
import { creationName, categoryFingerprint } from '../src/actual/category.mjs';
import { readEncryptedBackup } from '../src/backups/encrypted.mjs';
import { tempDirectory } from './helpers.mjs';
function fixture(t,options={}) {
  const config={dataDir:tempDirectory(t),householdId:'synthetic',dryRun:false,backup:{keyRef:'backup-key'},actual:{budgetId:'synthetic-budget',passwordRef:'password',timeoutMs:1000}};
  const group={id:'group',name:'Synthetic group',is_income:false,hidden:false},categories=[],calls=[];let syncs=0,created=false;
  const api={init:async()=>{},downloadBudget:async()=>{},shutdown:async()=>{},sync:async()=>{calls.push('sync');syncs++;if(syncs===2)options.duringBackup?.(group,categories);if(created&&options.syncFailure)throw Error('SECRET_CANARY');},getCategories:async()=>structuredClone(categories),getCategoryGroups:async()=>[structuredClone(group)],exportBudget:async()=>{calls.push('export');if(options.exportFailure)throw Error('SECRET_CANARY');return Buffer.from('504b0304abcd','hex');},createCategory:async args=>{calls.push(['create',args]);created=true;if(!options.noReadback)categories.push({id:'new-category',name:args.name,group_id:args.group_id,is_income:args.is_income,hidden:args.hidden});if(options.throwAfter)throw Error('SECRET_CANARY');return 'new-category';}};
  const resolveSecret=async ref=>ref==='backup-key'?'ab'.repeat(32):'synthetic';
  const executor=new ActualExecutor({api,config,resolveSecret,readbackTimeoutMs:20,pollIntervalMs:1});t.after(()=>executor.close());
  const args={operationId:'synthetic-operation',context:{householdId:config.householdId,budgetId:config.actual.budgetId},name:'Energia fictícia',groupId:'group',expectedGroup:{id:'group',name:'Synthetic group',isIncome:false,hidden:false}};
  return {config,group,categories,calls,executor,args,resolveSecret};
}
test('createCategory uses exact SDK external fields once, encrypted export and synchronized full readback',async t=>{
  const f=fixture(t),result=await f.executor.createCategory(f.args);
  assert.equal(result.status,'applied');assert.equal(result.category.name,'Energia fictícia');assert.equal(result.categoryFingerprint,categoryFingerprint(f.args.context,result.category));
  assert.deepEqual(f.calls.filter(x=>Array.isArray(x)),[['create',{name:'Energia fictícia',group_id:'group',is_income:false,hidden:false}]]);
  assert.ok(f.calls.indexOf('export')<f.calls.findIndex(Array.isArray));assert.equal(f.calls.filter(x=>x==='sync').length,3);
  assert.equal((await readEncryptedBackup(result.backupRef,{config:f.config,resolveSecret:f.resolveSecret})).toString('hex'),'504b0304abcd');
  const repeated=await f.executor.createCategory(f.args);assert.equal(repeated.status,'failed_before');assert.equal(repeated.code,'MUTATION_CONFLICT');assert.equal(f.calls.filter(Array.isArray).length,1);
});
test('hidden/renamed groups, duplicate names, invalid controls and changes during backup stop before SDK create',async t=>{
  for(const kind of ['hidden','renamed','duplicate','trim','unknown','duringBackup','backupFailure']){
    const f=fixture(t,{duringBackup:kind==='duringBackup'?group=>{group.name='changed';}:null,exportFailure:kind==='backupFailure'});
    if(kind==='hidden')f.group.hidden=true;if(kind==='renamed')f.group.name='changed';if(kind==='duplicate')f.categories.push({id:'old',name:'ENERGIA FICTÍCIA',group_id:'group',is_income:false,hidden:true});
    const result=await f.executor.createCategory({...f.args,...(kind==='trim'?{name:' Energia fictícia '}:{}),...(kind==='unknown'?{id:'MODEL_CHOSEN_ID'}:{})});
    assert.equal(result.status,'failed_before');assert.equal(f.calls.filter(Array.isArray).length,0);assert.doesNotMatch(JSON.stringify(result),/SECRET_CANARY/);
  }
  assert.equal(creationName(' Energia '),'Energia');assert.throws(()=>creationName('Nome\n/falso'),{code:'MUTATION_CATEGORY_INVALID'});
});
test('post-create timeout, throw and sync failures are uncertain; poisoned owner never repeats creation',async t=>{
  for(const options of [{noReadback:true},{throwAfter:true},{syncFailure:true}]){
    const f=fixture(t,options),result=await f.executor.createCategory(f.args);assert.equal(result.status,'uncertain');assert.equal(result.code,'MUTATION_UNCERTAIN');assert.ok(result.backupRef);
    const count=f.calls.length;assert.equal((await f.executor.createCategory(f.args)).code,'ACTUAL_FAILED');assert.equal(f.calls.length,count);assert.equal(f.calls.filter(Array.isArray).length,1);assert.doesNotMatch(JSON.stringify(result),/SECRET_CANARY/);
  }
});
test('createCategory worker timeout retires the SDK owner before any queued read and never resends the create',async t=>{
  const f=fixture(t),workers=[];let started,finish;
  const terminating=new Promise(resolve=>{started=resolve;}),retired=new Promise(resolve=>{finish=resolve;});
  class FakeWorker extends EventEmitter {stdout={resume(){}};stderr={resume(){}};messages=[];postMessage(message){this.messages.push(message);if(workers.length>1)queueMicrotask(()=>this.emit('message',{id:message.id,result:{fresh:true}}));}async terminate(){if(workers[0]===this){started();await retired;}this.emit('exit',0);}}
  const client=new ActualClient({...f.config,actual:{...f.config.actual,timeoutMs:20}},{createWorker(){const worker=new FakeWorker();workers.push(worker);return worker;}});
  let resolved=false;const write=client.createCategory(f.args).then(value=>{resolved=true;return value;}),read=client.inspectCategoryCatalog();
  await terminating;assert.equal(resolved,false);assert.equal(workers.length,1);assert.equal(workers[0].messages[0].operation,'createCategory');
  workers[0].emit('message',{id:workers[0].messages[0].id,result:{status:'applied'}});finish();assert.equal((await write).status,'uncertain');assert.deepEqual(await read,{fresh:true});assert.equal(workers.length,2);
  assert.equal(workers.flatMap(w=>w.messages).filter(m=>m.operation==='createCategory').length,1);await client.close();
});
