import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryStore} from './helpers.mjs';
import {financialSnapshot} from './fixtures/financial.mjs';
import {SkillSession,SKILLS} from '../src/skills/runtime.mjs';
import {reportIntent} from '../src/conversation/report-intent.mjs';
import {ConversationService} from '../src/conversation/service.mjs';
import {decodePngPhoto} from '../src/telegram/media.mjs';
const today='2026-09-24',now=()=>new Date(today+'T12:00:00Z');
function fixture(t){const {store,config,identity}=memoryStore(t);let reads=0;const actual={snapshot:async p=>{reads++;return financialSnapshot(p);}};const context={identity,allowedTransactionIds:new Set()};const session=new SkillSession({store,config,actual,now,tools:{execute:async()=>{throw Error('unexpected tool');}}});return {store,config,identity,actual,context,session,reads:()=>reads};}
test('exact reported macro and future requests resolve periods without invented restrictions',()=>{
  assert.deepEqual(reportIntent('Consegue me dar um grafico macro de como estão meus gastos esse mes?',today),{args:{start:'2026-09-01',end:today,groupBy:'group'},chart:true});
  assert.deepEqual(reportIntent('Faça uma busca de todos os gastos do mes de novembro de 2026, pegue as categorias macro e faça a somatização, me de os gastos por categoria macro, se puder, faça um grafico',today),{args:{start:'2026-11-01',end:'2026-11-30',groupBy:'group'},chart:true});
  assert.equal(reportIntent('gráfico somente Nubank este mês',today),null);
  assert.equal(reportIntent('gráfico para Consumo últimos 6 meses',today),null);
  assert.equal(reportIntent('relatório últimos 30 dias',today).args.start,'2026-08-26');
});
test('report chains to chart with all expenses, no additional read; opening and transfers excluded',async t=>{
  const f=fixture(t);f.actual.snapshot=async p=>{const s=financialSnapshot(p);s.categoryGroups=[{id:'g',name:'Pessoal'}];s.categories=s.categories.map(c=>({...c,groupId:'g'}));s.transactions.push({...s.transactions[0],id:'opening',amount:-900000,startingBalance:true});return s;};
  const report=await f.session.execute({name:'period_report',args:{start:'2026-09-01',end:today}},f.context);
  assert.equal(report.data.totals.netExpenses,102000);assert.equal(report.data.totals.inflowCents,107000);assert.equal(report.data.excluded.openingBalances,1);
  assert.equal(report.data.scope.includeClosed,true);assert.match(report.message.text,/Inclui o histórico de contas encerradas/);
  assert.equal(report.data.rows.find(r=>r.name==='Pessoal').netCents,99000);
  f.actual.snapshot=async()=>{throw Error('chart must reuse snapshot');};
  const chart=await f.session.execute({name:'render_chart',args:{},inputRef:report.data.resultRef},f.context);
  assert.ok(decodePngPhoto(chart.message.photo).bytes.length>1000);assert.match(chart.message.text,/R\$ 1\.020,00/);
  const other=new SkillSession({config:f.config,store:f.store,actual:f.actual});
  await assert.rejects(other.execute({name:'render_chart',args:{},inputRef:report.data.resultRef},f.context),{code:'INPUT_INVALID'});
});
test('every registered script has a manual; parameters and input references fail closed',async t=>{
  const f=fixture(t);
  for(const s of SKILLS){const result=await f.session.execute({name:'skill_help',args:{name:s.name}},f.context);assert.match(result.data.markdown,/## Goal/);assert.ok(result.data.parameters);}
  assert.throws(()=>f.session.resolve({name:'skill',args:{name:'delete_everything',parameters:'{}'}}));
  assert.throws(()=>f.session.resolve({name:'skill',args:{name:'period_report',parameters:'[]'}}));
  await assert.rejects(f.session.execute({name:'period_report',args:{start:'2026-09-01',end:today}},{...f.context,identity:{...f.identity,budgetId:'other'}}),{code:'UNAUTHORIZED'});
});
test('both failed user phrases return deterministic data and PNG with LLM down',async t=>{
  const f=fixture(t);let modelCalls=0;
  const service=new ConversationService({...f,now,providers:{complete:async()=>{modelCalls++;throw Error('offline');}}});
  for(const text of ['Consegue me dar um grafico macro de como estão meus gastos esse mes?','gastos por categoria macro novembro de 2026 com grafico']){
    const result=await service.respond({type:'message',text,identity:f.identity});assert.ok(result.photo);assert.doesNotMatch(result.text,/Não é possível buscar|não há categorias definidas/);
    if(text.includes('novembro'))assert.match(result.text,/Período futuro/);
  }
  assert.equal(modelCalls,0);assert.equal(f.reads(),2);
});
test('AI executes a composed skill chain through the real orchestration loop',async t=>{
  const f=fixture(t);let round=0;
  const providers={complete:async({tools,messages})=>{assert.deepEqual(tools.map(t=>t.name),['skill_help','skill']);const args=round++===0?{name:'period_report',parameters:JSON.stringify({start:'2026-09-01',end:today,groupBy:'group'})}:{name:'render_chart',parameters:'{}',inputRef:JSON.parse(messages.findLast(m=>m.role==='tool').content).resultRef};return {text:'',toolCalls:[{id:'s'+round,name:'skill',args}]};}};
  const service=new ConversationService({...f,now,providers});
  const response=await service.respond({type:'message',text:'Visualize a composição do meu dinheiro',identity:f.identity});
  assert.ok(response.photo);assert.equal(round,2);assert.equal(f.reads(),1);
});
test('financial replies without any read cannot invent absence of data',async t=>{
  const f=fixture(t);let attempts=0;const service=new ConversationService({...f,now,providers:{complete:async()=>{attempts++;return {text:'Não há categorias definidas',toolCalls:[]};}}});
  const result=await service.respond({type:'message',text:'Quais os gastos na minha conta específica?',identity:f.identity});
  assert.doesNotMatch(result.text,/Não há categorias definidas/);assert.match(result.text,/Não consegui consultar/);assert.equal(attempts,2);
});
test('explicit budget-specific technical categories stay separate, hidden regular expenses still count',async t=>{
  const f=fixture(t);f.store.setPreference('financial_report_policy',{version:1,budgetId:f.identity.budgetId,technicalCategoryIds:['technical']});
  f.actual.snapshot=async p=>{const s=financialSnapshot(p);s.categories.push({id:'technical',name:'Conciliação',isIncome:false,hidden:true});s.categories.find(c=>c.id==='food').hidden=true;s.transactions.push({...s.transactions[0],id:'credit',categoryId:'technical',amount:980000});return s;};
  const result=await f.session.execute({name:'period_report',args:{start:'2026-09-01',end:today}},f.context);
  assert.equal(result.data.totals.netExpenses,102000);assert.equal(result.data.technical.inflowCents,980000);assert.match(result.message.text,/Separado do gasto pessoal/);
});
test('skill search/category/proposal chain uses observed IDs and never confirms a write',async t=>{
  const f=fixture(t),executions=[];let round=0;
  const turns=[{name:'search_transactions',parameters:JSON.stringify({start:'2026-09-01',end:today})},{name:'list_categories',parameters:'{"text":"lanche"}'},{name:'prepare_category_changes',parameters:'{"changes":[{"transactionId":"1","categoryId":"food"}]}'}];
  const financeTools={execute:async(name,args,context)=>{executions.push(name);if(name==='search_transactions')return {data:{kind:'transactions',complete:true,period:{start:'2026-09-01',end:today},total:1,transactions:[{id:'observed',date:today,amountCents:-1000,payee:'Loja fictícia',notes:'Lanche',account:{id:'a',name:'Conta fictícia'},category:null,eligibleForCategoryChange:true}]}};
    if(name==='list_categories')return {data:{categories:[{id:'food',name:'Lanches'}]}};
    assert.equal(args.changes[0].transactionId,'observed');assert.ok(context.allowedTransactionIds.has('observed'));
    return {data:{kind:'proposal'},message:{text:'Proposta pendente. Nada foi alterado.',replyMarkup:{inline_keyboard:[]}}};}};
  const service=new ConversationService({...f,now,financeTools,providers:{complete:async()=>({text:'',toolCalls:[{id:'t'+round,name:'skill',args:turns[round++]}]})}});
  const response=await service.respond({type:'message',text:'Encontre uma compra e prepare sua classificação',identity:f.identity});
  assert.match(response.text,/Nada foi alterado/);assert.deepEqual(executions,['search_transactions','list_categories','prepare_category_changes']);assert.equal(round,3);
});
test('chart references are short and nested field normalization cannot inject values',async t=>{
  const f=fixture(t),report=await f.session.execute({name:'period_report',args:{start:'2026-09-01',end:today}},f.context);
  assert.deepEqual(report.data.nextSkill,{name:'render_chart',parameters:'{}',inputRef:report.data.resultRef});
  const call=f.session.resolve({name:'skill',args:{name:'render_chart',parameters:JSON.stringify({inputRef:report.data.resultRef})}});
  assert.ok((await f.session.execute(call,f.context)).message.photo);
  await assert.rejects(f.session.execute({name:'render_chart',args:{totals:999},inputRef:report.data.resultRef},f.context),{code:'INPUT_INVALID'});
});
