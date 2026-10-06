import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadReviewedPolicy,reviewedRecommendations} from '../src/categorization/reviewed-policy.mjs';
import {recommendCategories,automaticCandidate,automaticPolicyHash} from '../src/categorization/recommend.mjs';
const condition={field:'notes',op:'matches',value:'carrefour|supermercados bergamin'};
const policy={version:1,householdId:'home',budgetId:'hml',hash:'reviewed-hash',reviewRequired:['Vinicius de Souza Vaz'],rules:[{id:'market',categoryId:'market',conditions:[condition,{field:'amount',op:'gt',value:0,options:{outflow:true}}]}]};
const inspection=()=>({context:{householdId:'home',budgetId:'hml'},transaction:{id:'t',amount:-1142,notes:'Carrefour Bela Cintra',categoryId:null,accountId:'card',payeeId:null},categories:[{id:'market',name:'Mercado',hidden:false,isIncome:false},{id:'other',name:'Outros',hidden:false,isIncome:false}]});
test('reviewed policy classifies notes-only card expenses without a payee or model',()=>{
 const options=recommendCategories({inspection:inspection(),reviewedPolicy:policy});assert.equal(automaticCandidate(options).categoryId,'market');assert.equal(options[0].source,'reviewed');
});
test('manual choices, income, transfers, opening balances and split children are never rewritten',()=>{
 for(const extra of [{categoryId:'other'},{amount:1142},{transferId:'other'},{startingBalance:true},{isParent:true},{isChild:true}]){const i=inspection();Object.assign(i.transaction,extra);assert.equal(reviewedRecommendations(i,policy),null);}
});
test('unknown descriptions and another budget do not inherit local rules',()=>{
 const i=inspection();i.context.budgetId='wife';assert.equal(reviewedRecommendations(i,policy),null);i.context.budgetId='hml';i.transaction.notes='Compras diversas';assert.equal(reviewedRecommendations(i,policy),null);
});
test('conflicting or hidden destinations do not auto-apply',()=>{
 const p={...policy,rules:[...policy.rules,{id:'conflict',categoryId:'other',conditions:[condition]}]};assert.equal(automaticCandidate(reviewedRecommendations(inspection(),p)),null);
 const i=inspection();i.categories[0].hidden=true;assert.equal(automaticCandidate(reviewedRecommendations(i,policy)),null);
});
test('funded PIX requiring reconciliation cannot fall through to merchant rules',()=>{
 const i=inspection();i.transaction.notes='Vinicius de Souza Vaz';i.transaction.payeeId='merchant';
 assert.deepEqual(recommendCategories({inspection:i,reviewedPolicy:policy,rules:[{id:'wrong',payeeId:'merchant',categoryId:'market'}]}),[]);
});
test('changing reviewed policy invalidates previously queued automatic decisions',()=>{
 assert.notEqual(automaticPolicyHash({reviewedClassificationPolicy:{hash:'old'}}),automaticPolicyHash({reviewedClassificationPolicy:{hash:'new'}}));
});
test('reviewed policy file is optional, scoped and validated',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reviewed-policy-test-'));
 try{const c={dataDir:dir,householdId:'home',actual:{budgetId:'hml'}};assert.equal(loadReviewedPolicy(c),null);
 fs.writeFileSync(path.join(dir,'classification-policy.json'),JSON.stringify(policy));assert.equal(loadReviewedPolicy(c).rules.length,1);assert.throws(()=>loadReviewedPolicy({...c,actual:{budgetId:'production'}}));
 fs.writeFileSync(path.join(dir,'classification-policy.json'),JSON.stringify({...policy,rules:[{...policy.rules[0],conditions:[{field:'raw_sql',op:'exec',value:'delete'}]}]}));assert.throws(()=>loadReviewedPolicy(c));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
