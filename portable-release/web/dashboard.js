const $=id=>document.getElementById(id);
const money=n=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(n/100);
const compact=n=>new Intl.NumberFormat('pt-BR',{notation:'compact',maximumFractionDigits:1}).format(n/100);
const percent=n=>new Intl.NumberFormat('pt-BR',{style:'percent',maximumFractionDigits:1}).format(n);
const date=s=>s.split('-').reverse().join('/');
const monthName=s=>new Intl.DateTimeFormat('pt-BR',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(s+'-01T12:00:00Z'));
const normalize=s=>String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const node=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
const svg=(tag,attributes={})=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attributes))n.setAttribute(k,String(v));return n;};
const text=(id,value)=>{$(id).textContent=value;};
let data=null,filter=null,allCategories=false,tableLimit=100,timer,activeRequest,sequence=0,authenticated=false;
const signClass=(id,n)=>{$(id).classList.toggle('negative',n<0);$(id).classList.toggle('positive',n>=0);};

async function api(path,body,signal){
  const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined,credentials:'same-origin',cache:'no-store',signal});
  const result=await response.json();if(!response.ok){const error=new Error(result.message??'Não foi possível consultar o painel.');error.status=response.status;throw error;}return result;
}
function loginRequired(message){
  authenticated=false;data=null;clearTimeout(timer);$('content').hidden=true;$('logout').hidden=true;$('access').hidden=false;
  text('access-title','Seu painel é privado.');text('access-message',message??'Receba seu link pessoal na conversa com o bot.');$('access-tip').hidden=false;
}
function showFreshness(){
  if(!data)return;const stamp=new Date(data.readAt),age=Date.now()-stamp.getTime(),stale=age>60000||!$('error').hidden;
  text('freshness',`${stale?'Dados anteriores':'Actual consultado'} às ${stamp.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:data.timezone})}${document.hidden?' · atualização pausada':' · auto 20 s'}`);
  $('freshness').classList.toggle('stale',stale);
}
async function refresh(){
  clearTimeout(timer);if(document.hidden)return;
  const current=++sequence;activeRequest?.abort();activeRequest=new AbortController();$('refresh').disabled=true;
  const query=new URLSearchParams({mode:$('mode').value});if($('month').value)query.set('month',$('month').value);
  const timeout=setTimeout(()=>activeRequest?.abort(),90000);
  try{
    const result=await api('/api/dashboard?'+query,undefined,activeRequest.signal);if(current!==sequence)return;
    data=result;authenticated=true;$('access').hidden=true;$('content').hidden=false;$('logout').hidden=false;$('error').hidden=true;
    if(!$('month').value)$('month').value=result.today.slice(0,7);$('month').max=result.today.slice(0,7);
    render();
  }catch(error){
    if(current!==sequence)return;
    if(error.status===401){loginRequired(error.message);return;}
    const message=error.name==='AbortError'?'A consulta demorou mais que o esperado. Tentarei novamente.':error.message;
    if(data){$('error').hidden=false;text('error',message+' Os números abaixo são da última consulta concluída.');}
    else{text('access-title','Não consegui atualizar agora.');text('access-message',message+' Nova tentativa automática em 20 segundos.');}
  }finally{
    clearTimeout(timeout);if(current===sequence){$('refresh').disabled=false;showFreshness();if(authenticated)timer=setTimeout(refresh,20000);}
  }
}
function render(){
  text('base',data.base);text('period-title',data.mode==='month'?monthName(data.period.start.slice(0,7)):`Últimos 30 dias · ${date(data.period.start)} a ${date(data.period.end)}`);
  text('comparison-label',`${data.partial?'Até '+date(data.period.end)+' · ':''}comparação: ${date(data.comparison.start)} a ${date(data.comparison.end)}`);
  text('income',money(data.totals.netIncome));text('expense',money(data.totals.netExpenses));text('balance',money(data.totals.operatingResultCents));signClass('balance',data.totals.operatingResultCents);
  text('expense-detail',`${money(data.totals.grossExpenses)} em despesas − ${money(data.totals.refunds)} em estornos/reembolsos.`);
  const difference=data.totals.netExpenses-data.previousTotals.netExpenses;
  text('delta',(difference>0?'+':'')+money(difference));$('delta').className=difference>0?'negative':'positive';
  text('delta-detail',`${data.previousTotals.netExpenses>0?(difference>0?'+':'')+percent(difference/data.previousTotals.netExpenses)+' · ':''}período anterior: ${money(data.previousTotals.netExpenses)}`);
  renderSignals();renderCategories();renderTrend();renderSimulation();renderTransactions();renderQuality();showFreshness();
}
function inspect(kind,value,label){filter={kind,value,label};tableLimit=100;$('type').value='expense';$('search').value='';renderTransactions();$('transactions-section').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});}
function renderSignals(){
  const container=$('signals');container.replaceChildren();const top=data.categories.find(c=>c.netCents>0),up=data.signals.increases[0],small=data.signals.smallPayments;
  const add=(label,title,body,action)=>{const article=node('article',undefined,'signal');article.append(node('p',label,'signal-label'),node('h3',title),node('p',body));if(action){const b=node('button','Conferir lançamentos ↗');b.onclick=action;article.append(b);}container.append(article);};
  add('01 / Maior peso',top?`${top.name} · ${money(top.netCents)}`:'Sem despesas no período',top?`As três maiores categorias concentram ${percent(data.signals.topThreeShare)} dos gastos líquidos positivos. Comece conferindo o que compõe esse valor.`:'Troque o período para consultar os registros anteriores.',top?()=>inspect('category',top.key,top.name):null);
  add('02 / Atenção ao crescimento',up?`${up.name} · +${money(up.changeCents)}`:'Nenhuma categoria aumentou',up?`Antes: ${money(up.previousCents)}. Agora: ${money(up.netCents)}. ${up.previousCents===0?'Sem gasto líquido anterior; pode ser um gasto pontual.':'O aumento pode ser pontual; compare os lançamentos.'}`:'Dentro dos períodos comparados. Isso não identifica despesas ausentes da base.',up?()=>inspect('category',up.key,up.name):null);
  add('03 / Pequenos valores, juntos',`${small.count} lançamentos · ${money(small.outflowCents)}`,'Saídas de despesa de até R$ 50, antes de reembolsos; inclui partes de lançamentos divididos. Confira frequência e prioridade.',small.count?()=>inspect('small',null,'Lançamentos de até R$ 50'):null);
}
function renderCategories(){
  const group=$('grouping').value==='group';
  const rows=group?data.groups.map(r=>({...r,previousCents:null,group:null})):data.categories;
  const max=Math.max(1,...rows.map(r=>Math.abs(r.netCents))),container=$('category-chart');container.replaceChildren();
  if(!rows.length){container.append(node('p','Nenhuma despesa registrada neste período e escopo.','empty'));}
  for(const r of (allCategories?rows:rows.slice(0,8))){
    const button=node('button',undefined,'category-row'),head=node('span',undefined,'bar-heading'),label=node('span',r.name,'bar-label');
    if(r.group)label.append(node('span',r.group,'bar-sub'));head.append(label,node('strong',money(r.netCents)));button.append(head);
    const track=svg('svg',{viewBox:'0 0 100 6',preserveAspectRatio:'none','aria-hidden':'true',class:'bar-track'});
    track.append(svg('rect',{width:100,height:6,rx:3,fill:'#edf0e6'}),svg('rect',{width:Math.abs(r.netCents)/max*100,height:6,rx:3,fill:r.netCents<0?'#b7795f':'#52816a'}));button.append(track);
    const foot=node('span',undefined,'bar-foot');foot.append(node('span',`${r.count} lançamentos${r.netCents<0?' · reembolsos superam despesas':''}`));
    if(r.previousCents!==null&&r.previousCents!==undefined)foot.append(node('span',`${r.changeCents>0?'+':''}${money(r.changeCents)} vs. anterior`,r.changeCents>0?'increase':''));
    button.append(foot);button.onclick=()=>inspect(group?'group':'category',r.key,r.name);container.append(button);
  }
  $('show-categories').hidden=rows.length<=8;text('show-categories',allCategories?'Mostrar só as 8 maiores':`Ver todas (${rows.length})`);
}
function renderTrend(){
  const entries=data.trend,width=500,height=250,top=24,bottom=210,left=46,right=10;
  const values=entries.flatMap(r=>[r.incomeCents,r.expenseCents]),min=Math.min(0,...values),max=Math.max(100,...values),extent=max-min,chart=svg('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':'Renda categorizada e gasto líquido por mês. Os valores estão disponíveis na tabela abaixo.'});
  const y=v=>bottom-(v-min)/extent*(bottom-top),zero=y(0);
  for(let i=0;i<4;i++){const v=min+extent*i/3,yy=y(v);chart.append(svg('line',{x1:left,x2:width-right,y1:yy,y2:yy,stroke:'#e3e8de','stroke-dasharray':'3 4'}));const label=svg('text',{x:left-8,y:yy+4,'text-anchor':'end',fill:'#7b8378','font-size':10});label.textContent=compact(v);chart.append(label);}
  if(min<0)chart.append(svg('line',{x1:left,x2:width-right,y1:zero,y2:zero,stroke:'#9ba996'}));
  entries.forEach((r,index)=>{
    const step=(width-left-right)/entries.length,center=left+step*(index+.5);
    for(const[field,offset,color,label]of [['incomeCents',-19,'#216553','Renda'],['expenseCents',2,'#b7795f','Gasto']]){
      const v=r[field],rect=svg('rect',{x:center+offset,y:Math.min(y(v),zero),width:17,height:Math.abs(zero-y(v)),rx:3,fill:color,opacity:r.partial?.65:1});
      const title=svg('title');title.textContent=`${monthName(r.month)}${r.partial?' (parcial)':''} · ${label}: ${money(v)}`;rect.append(title);chart.append(rect);
    }
    const label=svg('text',{x:center,y:233,'text-anchor':'middle',fill:'#586d5a','font-size':11});label.textContent=new Intl.DateTimeFormat('pt-BR',{month:'short',timeZone:'UTC'}).format(new Date(r.month+'-01T12:00:00Z')).replace('.','')+(r.partial?'*':'');chart.append(label);
  });
  $('trend-chart').replaceChildren(chart);
  const table=node('table'),head=node('tr');for(const title of ['Mês','Renda','Gasto'])head.append(node('th',title));table.append(head);
  for(const r of entries){const tr=node('tr');tr.append(node('td',monthName(r.month)+(r.partial?' · parcial até '+date(r.period.end):'')),node('td',money(r.incomeCents)),node('td',money(r.expenseCents)));table.append(tr);}
  $('trend-table').replaceChildren(table);
  const recurring=data.signals.frequentPayees[0];
  text('trend-note',recurring?`Frequência para revisar: ${recurring.name}, ${recurring.count} lançamentos de saída somando ${money(recurring.outflowCents)} no período selecionado. Inclui partes de divisões; não comprova assinatura nem duplicidade.`:'O gráfico mostra somente lançamentos já existentes. Um mês vazio pode indicar falta de importação — não ausência de gastos.');
}
function renderSimulation(){
  const select=$('sim-category'),old=select.value;select.replaceChildren();
  for(const c of data.categories.filter(c=>c.netCents>0)){const option=node('option',`${c.name} · ${money(c.netCents)}`);option.value=c.key;select.append(option);}
  if([...select.options].some(o=>o.value===old))select.value=old;
  if(!select.options.length){const empty=node('option','Sem gastos positivos neste período');empty.value='';select.append(empty);}
  select.disabled=!data.categories.some(c=>c.netCents>0);$('sim-percent').disabled=select.disabled;calculateSavings();
}
function calculateSavings(){
  if(!data)return;const category=data.categories.find(c=>c.key===$('sim-category').value),reduction=Number($('sim-percent').value),saving=Math.round(Math.max(0,category?.netCents??0)*reduction/100);
  text('sim-label',reduction+'%');text('sim-saving',money(saving));
  text('sim-result',`Renda menos gastos passaria de ${money(data.totals.operatingResultCents)} para ${money(data.totals.operatingResultCents+saving)}, mantendo os outros registros iguais.`);
}
function renderTransactions(){
  const search=normalize($('search').value),type=$('type').value;
  const rows=data.transactions.filter(r=>(type==='all'||type===r.type)&&(!filter||(filter.kind==='category'?r.categoryKey===filter.value:filter.kind==='group'?r.groupKey===filter.value:r.amountCents<0&&r.amountCents>=-5000))&&(!search||normalize([r.payee,r.notes,r.category,r.group,r.account].join(' ')).includes(search)));
  text('transactions-title',filter?filter.label:'O que compõe os gastos');$('clear-filter').hidden=!filter;
  const out=rows.reduce((sum,r)=>sum+Math.max(0,-r.amountCents),0),incoming=rows.reduce((sum,r)=>sum+Math.max(0,r.amountCents),0);
  text('transaction-summary',`${rows.length} lançamentos · saídas ${money(out)} · entradas/reembolsos ${money(incoming)} · exibindo ${Math.min(rows.length,tableLimit)}`);
  const body=$('transactions');body.replaceChildren();
  for(const r of rows.slice(0,tableLimit)){
    const tr=node('tr'),description=node('td',r.payee);if(r.notes)description.append(node('span',r.notes,'txn-note'));
    tr.append(node('td',date(r.date)),description,node('td',r.category),node('td',r.account),node('td',(r.amountCents>0?'+':'')+money(r.amountCents),`numeric ${r.amountCents>0?'positive':''}`));body.append(tr);
  }
  if(!rows.length){const row=node('tr'),cell=node('td','Nenhum lançamento corresponde a este filtro.','empty');cell.colSpan=5;row.append(cell);body.append(row);}
  $('show-transactions').hidden=rows.length<=tableLimit;
}
function renderQuality(){
  const q=data.quality,container=$('quality');container.replaceChildren();
  for(const line of [
    q.uncategorizedCount?`${q.uncategorizedCount} lançamentos sem categoria reconhecida: ${money(q.uncategorizedOutflowCents)} em saídas a revisar.`:'Nenhum lançamento sem categoria reconhecida neste período e escopo.',
    `${money(q.unclassifiedInflowsCents)} em entradas sem categoria: não tratadas como renda.`,
    q.technicalPolicyConfigured?'Política de movimentos técnicos configurada especificamente para esta base.':'Esta base não tem exclusões técnicas configuradas. Revise empréstimos e conciliações antes de interpretar o resultado.',
    q.scope.includeClosed?'Histórico de contas encerradas incluído: encerrar uma conta não apaga suas receitas e despesas.':'Atenção: sua preferência exclui contas encerradas. Receitas e despesas antigas podem estar fora dos números.',
    'Classificação existente não comprova origem ou essencialidade do gasto. Verifique valores inesperados.'
  ])container.append(node('li',line));
  text('movement',`Antes de separar movimentos técnicos, foram registradas entradas de ${money(data.totals.inflowCents)} e saídas de ${money(data.totals.outflowCents)} no escopo. Estes não são totais brutos de movimentação de todas as contas.`);
  text('technical',`${q.technical.count} movimentos técnicos separados do gasto pessoal: ${money(q.technical.inflowCents)} em entradas e ${money(q.technical.outflowCents)} em saídas. Créditos de fatura e empréstimos não são renda de consumo.`);
  text('scope',`Contas no escopo: ${q.selectedAccounts.join('; ')||'nenhuma'}. Contas fora do orçamento: ${q.scope.includeOffBudget?'incluídas':'excluídas'}. Contas encerradas: ${q.scope.includeClosed?'incluídas':'excluídas'}.`);
  text('excluded',`Ignorados: ${q.excluded.transfers} registros de transferência vinculada, ${q.excluded.parents} pais de divisões, ${q.excluded.openingBalances} saldos iniciais e ${q.excluded.accounts} registros de contas fora do escopo.`);
  text('technical-categories',`Categorias técnicas: ${q.technicalCategoryNames.join('; ')||'nenhuma configurada'}.`);
}
$('refresh').onclick=refresh;
$('mode').onchange=()=>{$('month').hidden=$('mode').value==='last30';filter=null;refresh();};
$('month').onchange=()=>{filter=null;refresh();};
$('grouping').onchange=()=>{allCategories=false;if(data)renderCategories();};
$('show-categories').onclick=()=>{allCategories=!allCategories;renderCategories();};
$('sim-category').onchange=calculateSavings;$('sim-percent').oninput=calculateSavings;
$('search').oninput=()=>{tableLimit=100;if(data)renderTransactions();};$('type').onchange=()=>{tableLimit=100;if(data)renderTransactions();};
$('clear-filter').onclick=()=>{filter=null;renderTransactions();};$('show-transactions').onclick=()=>{tableLimit+=100;renderTransactions();};
$('logout').onclick=async()=>{try{await api('/api/dashboard/logout',{});sequence++;activeRequest?.abort();loginRequired('Você saiu do painel. Peça um novo acesso ao bot para voltar.');}catch{text('freshness','Não consegui encerrar o acesso. Tente novamente.');}};
document.addEventListener('visibilitychange',()=>{clearTimeout(timer);showFreshness();if(!document.hidden&&authenticated)refresh();});
async function boot(){
  const fragment=location.hash.slice(1),token=fragment&&fragment!=='method'?fragment:null;
  if(token)history.replaceState(null,'',location.pathname);
  try{if(token)await api('/api/dashboard/login',{token});authenticated=true;await refresh();}catch(error){loginRequired(error.message);}
}
boot();
