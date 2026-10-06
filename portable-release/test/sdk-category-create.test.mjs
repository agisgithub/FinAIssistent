import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker,isMainThread,parentPort,workerData } from 'node:worker_threads';
import { tempDirectory } from './helpers.mjs';
if(isMainThread){
  test('pinned SDK26.9 creates a category and categorizes a synthetic transaction with verified readback, no network', {timeout:120000},async t=>{
    const worker=new Worker(new URL(import.meta.url),{workerData:{dataDir:tempDirectory(t)},stdout:true,stderr:true});worker.stdout.resume();worker.stderr.resume();
    try{const result=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.once('exit',code=>{if(code!==0)reject(Error('Synthetic category worker failed'));});});assert.deepEqual(result,{ok:true,networkAttempts:0,created:true,categorized:true,otherFieldsUnchanged:true,duplicateRefused:true});}finally{await worker.terminate();}
  });
}else{
  process.stdout.write=()=>true;process.stderr.write=()=>true;
  const http=await import('node:http'),https=await import('node:https'),net=await import('node:net'),{syncBuiltinESMExports}=await import('node:module');
  let networkAttempts=0;const deny=()=>{networkAttempts++;throw Error('SYNTHETIC_NETWORK_BLOCKED');};
  http.default.request=deny;http.default.get=deny;https.default.request=deny;https.default.get=deny;net.default.connect=deny;net.default.createConnection=deny;globalThis.fetch=deny;syncBuiltinESMExports();
  const {loadPinnedActual}=await import('../src/actual/sdk-loader.mjs'),{ActualExecutor}=await import('../src/actual/executor.mjs');
  const api=await loadPinnedActual();let groupId,transactionId;
  const config={dataDir:workerData.dataDir,householdId:'synthetic',dryRun:false,backup:{keyRef:'synthetic-key'},actual:{budgetId:'synthetic-budget',passwordRef:'synthetic-password'}};
  const executor=new ActualExecutor({config,resolveSecret:async ref=>ref==='synthetic-key'?'9a'.repeat(32):'synthetic',api:{...api,
    init:({dataDir})=>api.init({dataDir,verbose:false}),sync:async()=>{},
    // Only remote authentication/sync are replaced. Category, transaction,
    // catalog and export calls all use the installed pinned SDK itself.
    downloadBudget:async()=>{await api.runImport('Synthetic create category',async()=>{});const account=await api.createAccount({name:'Synthetic account'});groupId=await api.createCategoryGroup({name:'Synthetic expenses'});const imported=await api.importTransactions(account,[{date:'2026-09-15',amount:-12345,payee_name:'Synthetic utility',notes:'Synthetic future bill',imported_id:'synthetic-create-category'}]);assert.equal(imported.errors.length,0);transactionId=(await api.getTransactions(account,'2026-09-01','2026-09-30'))[0].id;}
  }});
  try{
    await executor.runExclusive(async()=>{});const catalog=await executor.inspectCategoryCatalog(),group=catalog.groups.find(row=>row.id===groupId);
    const args={operationId:'synthetic-create',context:catalog.context,name:'Synthetic energy',groupId,expectedGroup:group};
    const created=await executor.createCategory(args);assert.equal(created.status,'applied');assert.ok(created.category.id);assert.equal(created.category.groupId,groupId);
    const duplicate=await executor.createCategory(args);assert.equal(duplicate.status,'failed_before');assert.equal(duplicate.code,'MUTATION_CONFLICT');
    const before=await executor.inspectTransaction(transactionId),changed=await executor.changeCategory({operationId:'synthetic-assign',context:before.context,targetId:transactionId,expectedFingerprint:before.fingerprint,categoryId:created.category.id,expectedCategory:created.category});
    assert.equal(changed.status,'applied');assert.deepEqual(changed.after,{...before.transaction,categoryId:created.category.id});await executor.close();
    parentPort.postMessage({ok:true,networkAttempts,created:true,categorized:true,otherFieldsUnchanged:true,duplicateRefused:true});
  }catch(error){try{await executor.close();}catch{}parentPort.postMessage({ok:false,networkAttempts,code:error.code??error.name});}
}
