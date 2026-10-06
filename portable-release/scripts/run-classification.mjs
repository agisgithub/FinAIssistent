// Reusable operator CLI. The daily bot scheduler uses the same recommendation
// engine and its existing durable operation journal, not a second cron/poller.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.mjs';
import {actualProfileConfig} from '../src/actual/base-registry.mjs';
import {ActualClient} from '../src/actual/client.mjs';
import {loadReviewedPolicy} from '../src/categorization/reviewed-policy.mjs';
import {automaticCandidate,recommendCategories,automaticPolicyHash} from '../src/categorization/recommend.mjs';
import {monitorInspection,assertMonitorSnapshot} from '../src/categorization/monitor.mjs';
import {localToday} from '../src/finance/periods.mjs';
const [mode,alias,file,receiptFile]=process.argv.slice(2);
assert.ok(['analyze','apply','rollback'].includes(mode)&&alias&&file,'Usage: node scripts/run-classification.mjs analyze|apply|rollback BASE PLAN_JSON [RECEIPT_JSON]');
const base=actualProfileConfig(await loadConfig(),alias),policy=loadReviewedPolicy(base);
assert.ok(policy,'A reviewed budget-local classification-policy.json is required');
const config={...base,reviewedClassificationPolicy:policy};
await fs.mkdir(base.dataDir,{recursive:true});
const dataDir=await fs.mkdtemp(path.join(base.dataDir,'classification-run-'));
const client=new ActualClient({...config,dataDir}),context={householdId:config.householdId,budgetId:config.actual.budgetId};
const save=(target,data)=>fs.writeFile(target,JSON.stringify(data,null,2),{mode:0o600});
try{
 if(mode==='analyze'){
  const today=localToday(config.timezone),start=new Date(today+'T12:00:00Z');start.setUTCDate(1);start.setUTCMonth(start.getUTCMonth()-11);
  const period={start:start.toISOString().slice(0,10),end:today},snapshot=assertMonitorSnapshot(await client.snapshot(period),config,period),proposals=[],pending=[];
  for(const t of snapshot.transactions){const i=monitorInspection(snapshot,t,config);if(!i.eligibility.eligible)continue;const candidate=automaticCandidate(recommendCategories({inspection:i,reviewedPolicy:policy}));
   if(!candidate){pending.push({id:t.id,date:t.date,amount:t.amount,notes:t.notes,payee:i.payee?.name??null,reason:'insufficient_or_conflicting_evidence'});continue;}
   proposals.push({targetId:t.id,fingerprint:i.fingerprint,categoryId:candidate.categoryId,categoryName:candidate.name,reason:candidate.evidence});
  }
  const plan={version:1,...context,serverURL:config.actual.serverURL,policyHash:automaticPolicyHash(config),period,createdAt:new Date().toISOString(),proposals,pending};await save(file,plan);
  console.log(JSON.stringify({mode,proposals:proposals.length,pending:pending.length,file,financialWrites:0}));
 }else{
  assert.ok(receiptFile&&receiptFile!==file,'Use a separate receipt file');assert.equal(config.dryRun,false,'Financial writes disabled');
  const plan=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(plan.budgetId,context.budgetId);assert.equal(plan.householdId,context.householdId);assert.equal(plan.serverURL,config.actual.serverURL);
  if(mode==='apply')assert.equal(plan.policyHash,automaticPolicyHash(config),'Policy changed; analyze again');
  const receipt={version:1,...context,serverURL:config.actual.serverURL,mode,source:file,backupDirectory:path.join(dataDir,'backups'),operations:[],state:'running'};await fs.writeFile(receiptFile,JSON.stringify(receipt,null,2),{mode:0o600,flag:'wx'});
  const targets=mode==='apply'?plan.proposals:[...plan.operations].reverse().filter(op=>op.result?.status==='applied');
  for(const p of targets){
   const targetId=p.targetId,current=await client.inspectTransaction(targetId),categoryId=mode==='apply'?p.categoryId:p.result.before.categoryId;
   const expected=mode==='apply'?p.fingerprint:p.result.afterFingerprint;assert.equal(current.fingerprint,expected,'Transaction changed; not overwriting');
   if(mode==='apply'){assert.equal(current.transaction.categoryId,null);assert.equal(automaticCandidate(recommendCategories({inspection:current,reviewedPolicy:policy}))?.categoryId,categoryId);}
   const expectedCategory=categoryId===null?null:current.categories.find(c=>c.id===categoryId&&!c.hidden);assert.ok(categoryId===null||expectedCategory);
   const op={operationId:randomUUID(),targetId,categoryId,status:'reserved'};receipt.operations.push(op);await save(receiptFile,receipt);
   op.result=await client.changeCategory({operationId:op.operationId,targetId,categoryId,expectedFingerprint:expected,expectedCategory,context});op.status=op.result.status;await save(receiptFile,receipt);
   assert.equal(op.status,'applied','Uncertain/failed result recorded. Do not blindly rerun.');
  }
  receipt.state='completed';await save(receiptFile,receipt);console.log(JSON.stringify({mode,completed:receipt.operations.length,receiptFile}));
 }
}finally{await client.close();}
