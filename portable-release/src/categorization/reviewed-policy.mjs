import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Reviewed, budget-local evidence. No arbitrary code, writes, model-generated
// selectors or category creation is accepted by this evaluator.
export function loadReviewedPolicy(config) {
  const file=path.join(config.dataDir,'classification-policy.json');
  if(!fs.existsSync(file))return null;
  const policy=JSON.parse(fs.readFileSync(file,'utf8'));
  if(policy.version!==1||policy.budgetId!==config.actual.budgetId||policy.householdId!==config.householdId||!Array.isArray(policy.rules)||policy.rules.length>256)throw Error('CLASSIFICATION_POLICY_INVALID');
  const fields=new Set(['notes','account','payee','amount','category']);
  for(const r of policy.rules){
    if(typeof r.id!=='string'||typeof r.categoryId!=='string'||!Array.isArray(r.conditions)||!r.conditions.length||r.conditions.length>50)throw Error('CLASSIFICATION_POLICY_INVALID');
    for(const c of r.conditions){
      if(!fields.has(c.field)||!['is','isNot','contains','doesNotContain','matches','gt','gte','lt','lte'].includes(c.op))throw Error('CLASSIFICATION_POLICY_INVALID');
      if(c.op==='matches'){if(typeof c.value!=='string'||c.value.length>1500)throw Error('CLASSIFICATION_POLICY_INVALID');new RegExp(c.value,'i');}
    }
  }
  if(!Array.isArray(policy.reviewRequired??[])||(policy.reviewRequired??[]).some(x=>typeof x!=='string'||x.length>500))throw Error('CLASSIFICATION_POLICY_INVALID');
  return {...policy,hash:createHash('sha256').update(JSON.stringify(policy)).digest('hex')};
}
function match(c,t){
  let v={notes:t.notes??'',account:t.accountId,payee:t.payeeId,amount:t.amount,category:t.categoryId}[c.field],want=c.value;
  if(c.field==='amount'&&c.options?.outflow){if(v>=0)return false;v=-v;}
  if(c.field==='amount'&&c.options?.inflow&&v<=0)return false;
  if(c.field==='notes'){v=v.toLowerCase();if(typeof want==='string')want=want.toLowerCase();}
  switch(c.op){case 'is':return v===want;case 'isNot':return v!==want;case 'contains':return typeof v==='string'&&v.includes(want);case 'doesNotContain':return typeof v==='string'&&!v.includes(want);case 'matches':return typeof v==='string'&&new RegExp(c.value,'i').test(v);case 'gt':return v>want;case 'gte':return v>=want;case 'lt':return v<want;case 'lte':return v<=want;default:return false;}
}
export function reviewedRecommendations(inspection,policy){
  if(!policy||policy.budgetId!==inspection.context.budgetId||policy.householdId!==inspection.context.householdId)return null;
  const t=inspection.transaction;
  if((policy.reviewRequired??[]).some(note=>(t.notes??'').trim().toLowerCase()===note.toLowerCase()))return [];
  if(t.categoryId!==null||t.amount>=0||t.transferId||t.isParent||t.isChild||t.startingBalance||inspection.payee?.transferAccountId)return null;
  const matched=policy.rules.filter(r=>r.conditions.every(c=>match(c,t)));
  if(!matched.length)return null;
  const ids=[...new Set(matched.map(r=>r.categoryId))],catalog=new Map(inspection.categories.filter(c=>!c.hidden&&!c.isIncome).map(c=>[c.id,c]));
  const conflict=ids.length!==1||ids.some(id=>!catalog.has(id));
  return ids.filter(id=>catalog.has(id)).map(categoryId=>({categoryId,name:catalog.get(categoryId).name,source:'reviewed',score:conflict ? .65 : .99,confidence:conflict?'média':'alta',evidence:{conflict,count:matched.length,total:matched.length,agreement:conflict?null:1,ruleIds:matched.map(r=>r.id),policyHash:policy.hash}}));
}
