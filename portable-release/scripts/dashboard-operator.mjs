// Operator smoke / owner notification. Never prints tokens or financial transaction details.
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import {loadConfig} from '../src/config.mjs';
import {actualProfileConfig} from '../src/actual/base-registry.mjs';
import {webSettings} from '../src/onboarding/settings.mjs';
import {DashboardAccess,DASHBOARD_COOKIE} from '../src/dashboard/access.mjs';
import {TelegramClient} from '../src/telegram/client.mjs';
import {secretResolver} from '../src/secrets/resolver.mjs';

const mode=process.argv[2];if(!['check','notify'].includes(mode))throw Error('Use: dashboard-operator.mjs check|notify [base-alias]');
const base=await loadConfig(),settings=webSettings(base),alias=process.argv[3]??base.actual.defaultBase,profile=actualProfileConfig(base,alias);
const db=new Database(path.join(settings.dataDir,'registry.sqlite'));db.pragma('busy_timeout = 5000');
const access=new DashboardAccess(db),token=access.issue({userId:base.telegram.userId,alias,budgetId:profile.actual.budgetId});
try {
  if(mode==='notify') {
    const telegram=new TelegramClient({config:base,resolveSecret:secretResolver(base.secretDir)});
    const messageId=await telegram.sendMessage(base.telegram.chatId,{text:`Seu dashboard vivo está pronto · ${alias}\n\n${settings.publicUrl}/dashboard#${token}\n\nAbra este link privado em até 10 minutos, na rede/VPN do servidor. Depois de aberto, o acesso dura 12 horas. Para outro link, basta me dizer “dashboard”.\n\nO painel mostra renda e gasto pessoal, evolução mensal, categorias que mais pesam, aumentos, pequenos pagamentos e um simulador de economia. Clique nas categorias para ver os lançamentos.\n\nAtualização automática a cada 20 segundos com a aba aberta, refletindo o que já chegou ao Actual. Transferências vinculadas, saldos iniciais e movimentos técnicos ficam separados. Nenhum lançamento foi alterado pelo dashboard.`});
    console.log(JSON.stringify({delivered:true,messageId,base:alias}));
  }else{
    const ca=await fs.readFile(settings.certFile);
    const request=(pathname,{body,cookie}={})=>new Promise((resolve,reject)=>{
      const req=https.request(new URL(pathname,settings.publicUrl),{ca,method:body?'POST':'GET',headers:{...(body?{'content-type':'application/json',origin:settings.publicUrl}:{}),...(cookie?{cookie}:{})}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(text)});}catch{reject(Error('Invalid JSON response'));}});});req.setTimeout(150000,()=>req.destroy(Error('Timeout')));req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();
    });
    const anonymous=await request('/api/dashboard');assert.equal(anonymous.status,401);
    const login=await request('/api/dashboard/login',{body:{token}});assert.equal(login.status,200);const cookie=login.headers['set-cookie'][0].split(';')[0];assert.ok(cookie.startsWith(DASHBOARD_COOKIE+'='));
    const results=[];
    try{
      for(const query of [...Array.from({length:14},(_,i)=>'?month='+new Date(Date.UTC(2025,7+i,1)).toISOString().slice(0,7)),'?mode=last30']) {
        const response=await request('/api/dashboard'+query,{cookie});assert.equal(response.status,200);const d=response.body;
        assert.equal(d.base,alias);assert.equal(d.categories.reduce((s,c)=>s+c.netCents,0),d.totals.netExpenses);assert.equal(d.groups.reduce((s,c)=>s+c.netCents,0),d.totals.netExpenses);
        assert.equal(d.transactions.filter(t=>t.type==='expense').reduce((s,t)=>s-t.amountCents,0),d.totals.netExpenses);
        assert.equal(d.trend.length,6);assert.ok(d.readAt);assert.equal(d.quality.technicalPolicyConfigured,true);
        results.push({period:d.period,readAt:d.readAt,scope:d.quality.scope,transactions:d.transactions.length,categories:d.categories.length,totals:d.totals,technical:d.quality.technical,uncategorized:d.quality.uncategorizedCount});
      }
    }finally{const result=await request('/api/dashboard/logout',{body:{},cookie});assert.equal(result.status,200);assert.equal((await request('/api/dashboard',{cookie})).status,401);}
    console.log(JSON.stringify({ok:true,base:alias,financialWrites:0,checks:results},null,2));
  }
}finally{db.close();}
