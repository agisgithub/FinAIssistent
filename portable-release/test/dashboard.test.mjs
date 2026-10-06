import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {memoryStore,update} from './helpers.mjs';
import {financialSnapshot} from './fixtures/financial.mjs';
import {OnboardingStore} from '../src/onboarding/store.mjs';
import {DashboardAccess,DASHBOARD_COOKIE} from '../src/dashboard/access.mjs';
import {dashboardPeriods,buildDashboard,DashboardService} from '../src/dashboard/data.mjs';
import {createWebHandler} from '../src/onboarding/http.mjs';
import {routeGatewayUpdate} from '../src/onboarding/gateway.mjs';

const today='2026-09-24';
function fixture(t){
  const f=memoryStore(t);let now=Date.parse(today+'T12:00:00Z'),reads=0,available=true;
  const registry=new OnboardingStore(':memory:',randomBytes(32),{now:()=>now});t.after(()=>registry.close());
  const access=new DashboardAccess(registry.db,{now:()=>now});
  const actual={snapshot:async period=>{reads++;const s=financialSnapshot(period);s.categoryGroups=[];return s;}};
  const runtime={...f,actual},household={runtimes:new Map([['test',runtime]]),router:{selection:()=>({alias:'test'})}};
  const dashboard=new DashboardService({access,getRuntime:userId=>available&&userId===123?household:null,now:()=>now});
  return {...f,registry,access,actual,runtime,household,dashboard,advance:ms=>{now+=ms;},remove:()=>{available=false;},reads:()=>reads,login:()=>dashboard.login(dashboard.link(123).token)};
}

test('dashboard periods use month-to-date comparison, full historical months and rolling windows',()=>{
  const p=dashboardPeriods({},today);assert.deepEqual(p.current,{start:'2026-09-01',end:today});assert.deepEqual(p.previous,{start:'2026-08-01',end:'2026-08-24'});assert.equal(p.series.length,6);
  assert.deepEqual(dashboardPeriods({month:'2026-06'},today).previous,{start:'2026-05-01',end:'2026-05-31'});
  assert.deepEqual(dashboardPeriods({mode:'last30'},today).previous,{start:'2026-07-27',end:'2026-08-25'});
  assert.deepEqual(dashboardPeriods({},'2026-03-30').previous,{start:'2026-02-01',end:'2026-02-28'});
  assert.throws(()=>dashboardPeriods({month:'2026-13'},today));assert.throws(()=>dashboardPeriods({month:'2026-10'},today));assert.throws(()=>dashboardPeriods({mode:'whatever'},today));
});

test('dashboard reuses accounting: excludes technical/opening/transfers, counts splits once and preserves Consumo',t=>{
  const f=fixture(t),periods=dashboardPeriods({},today),snapshot=financialSnapshot(periods.fetch);snapshot.categoryGroups=[{id:'g',name:'Vida pessoal'}];
  f.store.setPreference('finance_scope',{includeOffBudget:false,includeClosed:false});
  snapshot.categories.forEach(c=>c.groupId='g');snapshot.categories.find(c=>c.id==='transport').name='Consumo';
  snapshot.categories.push({id:'technical',name:'Financiamento',isIncome:false});
  const tx=snapshot.transactions[0];snapshot.transactions.push({...tx,id:'opening',amount:-500000,startingBalance:true},{...tx,id:'technical-in',amount:990000,categoryId:'technical'},{...tx,id:'technical-out',amount:-1000,categoryId:'technical'},{...tx,id:'previous',date:'2026-08-10',amount:-5000});
  f.store.setPreference('financial_report_policy',{version:1,budgetId:f.config.actual.budgetId,technicalCategoryIds:['technical']});
  const data=buildDashboard(snapshot,{...f,alias:'test',periods,today});
  assert.equal(data.totals.netExpenses,32000);assert.equal(data.totals.netIncome,99000);assert.equal(data.totals.operatingResultCents,67000);
  assert.equal(data.quality.technical.inflowCents,990000);assert.equal(data.quality.technical.outflowCents,1000);assert.equal(data.quality.excluded.openingBalances,1);
  assert.equal(data.quality.uncategorizedCount,2);assert.equal(data.totals.unclassifiedInflows,5000);
  assert.equal(data.categories.find(c=>c.name==='Consumo').netCents,2000);assert.equal(data.previousTotals.netExpenses,5000);
  assert.equal(data.categories.reduce((s,c)=>s+c.netCents,0),data.totals.netExpenses);
  assert.equal(data.groups.reduce((s,c)=>s+c.netCents,0),data.totals.netExpenses);
  assert.equal(data.trend.at(-1).expenseCents,data.totals.netExpenses);
  assert.equal(data.transactions.filter(t=>t.type==='expense').reduce((s,t)=>s-t.amountCents,0),data.totals.netExpenses);
  assert.ok(data.transactions.every(t=>!('id' in t)));assert.equal(data.quality.technicalPolicyConfigured,true);
});

test('historical dashboard includes closed-account income, expenses and refunds by default, not off-budget debt',t=>{
  const f=fixture(t),periods=dashboardPeriods({month:'2026-04'},today),snapshot=financialSnapshot(periods.fetch);
  const tx={id:'salary-old',date:'2026-04-10',amount:486181,accountId:'closed',categoryId:'income',payeeId:'shop',isParent:false,transferId:null};
  snapshot.transactions=[tx,{...tx,id:'current-income',accountId:'checking',amount:83297},{...tx,id:'expense',accountId:'checking',categoryId:'food',amount:-985962},{...tx,id:'refund-old',categoryId:'food',amount:51393},{...tx,id:'off-income',accountId:'off',amount:60000}];
  snapshot.categoryGroups=[];
  const d=buildDashboard(snapshot,{...f,alias:'test',periods,today});
  assert.equal(d.totals.netIncome,569478);assert.equal(d.totals.netExpenses,934569);assert.equal(d.totals.operatingResultCents,-365091);
  assert.equal(d.quality.scope.includeClosed,true);assert.equal(d.quality.scope.includeOffBudget,false);
  assert.equal(d.trend.at(-1).incomeCents,d.totals.netIncome);
  assert.equal(d.trend.at(-1).expenseCents,d.totals.netExpenses);
  assert.ok(d.transactions.some(row=>row.account==='Conta encerrada fictícia'));assert.equal(d.quality.excluded.accounts,1);
  f.store.setPreference('finance_scope',{includeOffBudget:false,includeClosed:false});
  const restricted=buildDashboard(snapshot,{...f,alias:'test',periods,today});assert.equal(restricted.totals.netIncome,83297);assert.equal(restricted.totals.netExpenses,985962);
});

test('links are hashed, single-use, expire, and sessions revoke/expire without crossing users',t=>{
  const f=fixture(t),link=f.access.issue({userId:123,alias:'test',budgetId:'a'});
  assert.ok(!JSON.stringify(f.registry.db.prepare('SELECT * FROM dashboard_links').all()).includes(link));
  const session=f.access.exchange(link);assert.deepEqual(f.access.session(session),{userId:123,alias:'test',budgetId:'a'});assert.throws(()=>f.access.exchange(link),{status:401});
  const other=f.access.exchange(f.access.issue({userId:456,alias:'test',budgetId:'b'}));
  const replacement=f.access.exchange(f.access.issue({userId:123,alias:'test',budgetId:'a'}));
  assert.throws(()=>f.access.session(session),{status:401});assert.equal(f.access.session(other).userId,456);
  f.access.revoke(replacement);assert.throws(()=>f.access.session(replacement),{status:401});
  const expired=f.access.issue({userId:123,alias:'test',budgetId:'a'});f.advance(10*60000);assert.throws(()=>f.access.exchange(expired),{status:401});
  f.advance(12*3600000);assert.throws(()=>f.access.session(other),{status:401});assert.throws(()=>f.access.session(undefined),{status:401});
});

test('data is identity/budget bound and cached briefly; new reads reflect changed amounts',async t=>{
  const f=fixture(t),cookie=f.login();
  const [one,two]=await Promise.all([f.dashboard.data(cookie,{}),f.dashboard.data(cookie,{})]);assert.equal(f.reads(),1);assert.equal(one.totals.netExpenses,two.totals.netExpenses);
  f.advance(15001);const old=f.actual.snapshot;f.actual.snapshot=async p=>{const s=await old(p);s.transactions[0].amount-=10000;return s;};
  const changed=await f.dashboard.data(cookie,{});assert.equal(changed.totals.netExpenses-one.totals.netExpenses,10000);assert.equal(f.reads(),2);assert.notEqual(one.readAt,changed.readAt);
  f.runtime.config={...f.config,actual:{...f.config.actual,budgetId:'another'}};await assert.rejects(f.dashboard.data(cookie,{}),{status:401});
});

test('incomplete snapshots and wrong identity fail closed; source outage never returns cached success',async t=>{
  const f=fixture(t),cookie=f.login();await f.dashboard.data(cookie,{});f.advance(15001);
  f.actual.snapshot=async()=>{throw Error('credentials not leaked');};await assert.rejects(f.dashboard.data(cookie,{}),e=>e.status===503&&!e.message.includes('credentials'));
  f.actual.snapshot=async p=>({...financialSnapshot(p),categoryGroups:[],budgetId:'another'});await assert.rejects(f.dashboard.data(cookie,{}),{code:'UNAUTHORIZED'});
  f.advance(15001);f.actual.snapshot=async p=>({...financialSnapshot(p),categoryGroups:[],coverage:{complete:false,failedAccountIds:['checking']}});await assert.rejects(f.dashboard.data(cookie,{}),{code:'SNAPSHOT_INVALID'});
  f.remove();await assert.rejects(f.dashboard.data(cookie,{}),{status:401});
});

test('dashboard route returns private HTML, requires secure login and enforces origin/logout',async t=>{
  const f=fixture(t),settings={publicUrl:'https://example.test'},server=http.createServer(createWebHandler({service:{},settings,dashboard:f.dashboard}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const url='http://127.0.0.1:'+server.address().port;
  const html=await fetch(url+'/dashboard');assert.equal(html.status,200);assert.equal(html.headers.get('cache-control'),'no-store');assert.match(await html.text(),/Encontre a folga/);
  const denied=await fetch(url+'/api/dashboard');assert.equal(denied.status,401);
  const token=f.dashboard.link(123).token,post=(path,body,headers={})=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post('/api/dashboard/login',{token})).status,403);
  const login=await post('/api/dashboard/login',{token},{origin:settings.publicUrl});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie');assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);assert.match(cookie,/__Host-finai-dashboard/);
  const result=await fetch(url+'/api/dashboard',{headers:{cookie:cookie.split(';')[0]}});assert.equal(result.status,200);assert.equal((await result.json()).base,'test');
  assert.equal((await fetch(url+'/api/dashboard?budgetId=another',{headers:{cookie:cookie.split(';')[0]}})).status,400);
  const logout=await post('/api/dashboard/logout',{},{origin:settings.publicUrl,cookie:cookie.split(';')[0]});assert.equal(logout.status,200);
  assert.equal((await fetch(url+'/api/dashboard',{headers:{cookie:cookie.split(';')[0]}})).status,401);
});

test('natural dashboard request is delivered exactly once and never leaks to another chat',t=>{
  const f=fixture(t),settings={publicUrl:'https://example.test'},context={store:f.registry,settings,dashboard:f.dashboard,getRuntime:id=>id===123?f.household:null};
  routeGatewayUpdate(update(1,'abrir painel de gastos'),context);routeGatewayUpdate(update(1,'abrir painel de gastos'),context);
  const delivery=f.registry.claimDelivery();assert.equal(delivery.chat_id,123);assert.match(delivery.payload.text,/dashboard#/);assert.match(delivery.payload.text,/test/);assert.equal(f.registry.claimDelivery(),null);
  routeGatewayUpdate(update(2,'dashboard',{chat:{id:456,type:'private'}}),context);assert.equal(f.registry.claimDelivery(),null);
});
