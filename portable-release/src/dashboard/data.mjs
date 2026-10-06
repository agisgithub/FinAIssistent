import {periodReportSnapshot} from '../skills/period-report.mjs';
import {localToday} from '../finance/periods.mjs';
import {RegistrationError} from '../onboarding/store.mjs';

const iso=date=>date.toISOString().slice(0,10);
const day=(date,offset)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+offset);return iso(d);};
const month=(date,offset)=>{const d=new Date(date.slice(0,7)+'-01T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+offset);return iso(d);};
const monthEnd=date=>day(month(date,1),-1);
const invalid=()=>{throw new RegistrationError('DASHBOARD_PERIOD','Escolha um mês válido, de 2000 até o mês atual.',400);};

export function dashboardPeriods(query,today) {
  const mode=query.mode??'month';if(!['month','last30'].includes(mode))invalid();
  const selected=query.month??today.slice(0,7);
  if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(selected)||selected>today.slice(0,7))invalid();
  let current,previous;
  if(mode==='last30'){
    current={start:day(today,-29),end:today};previous={start:day(today,-59),end:day(today,-30)};
  }else{
    current={start:selected+'-01',end:selected===today.slice(0,7)?today:monthEnd(selected)};
    const start=month(current.start,-1),last=monthEnd(start);
    // Compare equal elapsed calendar days for a partial month, full months for historical months.
    previous={start,end:current.end===today&&today<monthEnd(today)?start.slice(0,8)+String(Math.min(Number(today.slice(8)),Number(last.slice(8)))).padStart(2,'0'):last};
  }
  const series=Array.from({length:6},(_,i)=>{
    const start=month(current.end,i-5);return {start,end:monthEnd(start)<current.end?monthEnd(start):current.end};
  });
  return {mode,current,previous,series,fetch:{start:series[0].start<previous.start?series[0].start:previous.start,end:current.end}};
}

export function buildDashboard(snapshot,{config,store,alias,periods,today}) {
  const report=period=>periodReportSnapshot({...period,groupBy:'group'},{config,store,today,snapshot:{...snapshot,period,transactions:snapshot.transactions.filter(t=>t.date>=period.start&&t.date<=period.end)}});
  const current=report(periods.current),previous=report(periods.previous),{analysis,data}=current;
  const groups=new Map(snapshot.categoryGroups.map(g=>[g.id,g.name])),accounts=new Map(snapshot.accounts.map(a=>[a.id,a.name]));
  const groupFor=(category,id)=>({key:category?.groupId??'uncategorized',name:groups.get(category?.groupId)??(id?'Grupo não identificado':'Sem categoria')});
  const prevCategories=new Map(previous.analysis.byCategory.map(c=>[c.id,c]));
  const categories=analysis.byCategory.map(c=>{const group=groupFor(analysis.categories.get(c.id),c.id);return {key:c.id??'uncategorized',name:c.name,group:group.name,groupKey:group.key,grossCents:c.gross,refundCents:c.refunds,netCents:c.net,count:c.count,previousCents:prevCategories.get(c.id)?.net??0,changeCents:c.net-(prevCategories.get(c.id)?.net??0)};});
  const groupTotals=new Map();for(const c of categories){const g=groupTotals.get(c.groupKey)??{key:c.groupKey,name:c.group,grossCents:0,refundCents:0,netCents:0,count:0};for(const field of ['grossCents','refundCents','netCents','count'])g[field]+=c[field];groupTotals.set(c.groupKey,g);}
  const transactions=analysis.includedTransactions.map(t=>{
    const category=analysis.categories.get(t.categoryId),payee=analysis.payees.get(t.payeeId);
    const group=groupFor(category,t.categoryId);
    return {date:t.date,amountCents:t.amount,categoryKey:t.categoryId??'uncategorized',category:category?.name??'Sem categoria',group:group.name,groupKey:group.key,payee:payee?.name||'Favorecido não informado',notes:t.notes??'',account:accounts.get(t.accountId)??'Conta não identificada',type:category?.isIncome?'income':t.amount>0&&!category?'unclassified-inflow':'expense'};
  }).sort((a,b)=>b.date.localeCompare(a.date)||Math.abs(b.amountCents)-Math.abs(a.amountCents));
  const expenses=transactions.filter(t=>t.type==='expense'),merchants=new Map();
  for(const row of expenses.filter(t=>t.amountCents<0)) {
    const key=row.payee==='Favorecido não informado'?row.notes||row.payee:row.payee;
    const m=merchants.get(key)??{name:key,count:0,outflowCents:0};m.count++;m.outflowCents-=row.amountCents;merchants.set(key,m);
  }
  const uncategorized=analysis.includedTransactions.filter(t=>!analysis.categories.has(t.categoryId));
  const small=expenses.filter(t=>t.amountCents<0&&t.amountCents>=-5000);
  const positive=categories.filter(c=>c.netCents>0),positiveTotal=positive.reduce((sum,c)=>sum+c.netCents,0);
  return {
    version:1,base:alias,currency:config.currency,timezone:config.timezone,today,syncedAt:snapshot.syncedAt,
    period:periods.current,comparison:periods.previous,mode:periods.mode,partial:periods.current.end===today,
    totals:{...data.totals,operatingResultCents:data.totals.netIncome-data.totals.netExpenses},
    previousTotals:previous.data.totals,groups:[...groupTotals.values()].sort((a,b)=>b.netCents-a.netCents||a.name.localeCompare(b.name)),categories,transactions,
    trend:periods.series.map(period=>{const r=report(period).data;return {month:period.start.slice(0,7),period,partial:period.end<monthEnd(period.start),incomeCents:r.totals.netIncome,expenseCents:r.totals.netExpenses};}),
    signals:{topThreeShare:positiveTotal?positive.slice(0,3).reduce((s,c)=>s+c.netCents,0)/positiveTotal:0,smallPayments:{count:small.length,outflowCents:small.reduce((s,t)=>s-t.amountCents,0)},increases:categories.filter(c=>c.changeCents>0&&c.netCents>0).sort((a,b)=>b.changeCents-a.changeCents).slice(0,3),frequentPayees:[...merchants.values()].filter(m=>m.count>=3).sort((a,b)=>b.outflowCents-a.outflowCents).slice(0,5)},
    quality:{uncategorizedCount:uncategorized.length,uncategorizedOutflowCents:uncategorized.reduce((s,t)=>s+Math.max(0,-t.amount),0),unclassifiedInflowsCents:data.totals.unclassifiedInflows,technical:data.technical,excluded:data.excluded,scope:data.scope,selectedAccounts:analysis.selectedAccounts.map(a=>a.name),technicalCategoryNames:[...current.technicalIds].map(id=>analysis.categories.get(id)?.name??'Categoria indisponível'),technicalPolicyConfigured:current.technicalIds.size>0},
  };
}

export class DashboardService {
  constructor({access,getRuntime,now=Date.now,cacheMs=15000}){this.access=access;this.getRuntime=getRuntime;this.now=now;this.cacheMs=cacheMs;this.cache=new WeakMap();}
  binding(session){
    const household=this.getRuntime(session.userId),runtime=household?.runtimes.get(session.alias);
    if(!runtime||runtime.config.actual.budgetId!==session.budgetId||runtime.config.telegram.userId!==session.userId)throw new RegistrationError('DASHBOARD_ACCESS','O acesso mudou. Peça “dashboard” no Telegram novamente.',401);
    return runtime;
  }
  link(userId){
    const household=this.getRuntime(userId),alias=household?.router.selection().alias,runtime=household?.runtimes.get(alias);
    if(!runtime)throw new RegistrationError('DASHBOARD_UNAVAILABLE','Conecte seu orçamento pelo cadastro primeiro.',409);
    return {token:this.access.issue({userId,alias,budgetId:runtime.config.actual.budgetId}),alias};
  }
  login(token){const cookie=this.access.exchange(token);try{this.binding(this.access.session(cookie));}catch(e){this.access.revoke(cookie);throw e;}return cookie;}
  async data(cookie,query){
    const session=this.access.session(cookie),runtime=this.binding(session),today=localToday(runtime.config.timezone,new Date(this.now()));
    const periods=dashboardPeriods(query,today),key=JSON.stringify(periods.fetch);
    let entries=this.cache.get(runtime);if(!entries){entries=new Map();this.cache.set(runtime,entries);}
    let entry=entries.get(key);
    if(!entry||(!entry.pending&&this.now()-entry.at>=this.cacheMs)){
      // Bound the cache to a handful of month selections. In-flight reads reuse the Actual queue.
      for(const [k,v]of entries)if(!v.pending)entries.delete(k);
      if(entries.size>=4)throw new RegistrationError('DASHBOARD_BUSY','Aguarde a consulta atual terminar.',429);
      entry={pending:true,at:0};entries.set(key,entry);
      entry.promise=runtime.actual.snapshot(periods.fetch).then(snapshot=>{entry.at=this.now();entry.pending=false;return snapshot;}).catch(error=>{entries.delete(key);throw error;});
    }
    let snapshot;try{snapshot=await entry.promise;}catch{throw new RegistrationError('ACTUAL_UNAVAILABLE','Não consegui atualizar o Actual. Os dados anteriores, se visíveis, não estão atualizados. Tente novamente.',503);}
    this.access.session(cookie);if(this.binding(session)!==runtime)throw new RegistrationError('DASHBOARD_ACCESS','A conexão foi atualizada. Reabra o painel.',401);
    return {...buildDashboard(snapshot,{...runtime,alias:session.alias,periods,today}),readAt:new Date(entry.at).toISOString(),refreshSeconds:20};
  }
}
