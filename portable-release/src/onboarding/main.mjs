import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setDefaultResultOrder} from 'node:dns';
import {setTimeout as sleep} from 'node:timers/promises';
import {loadConfig,validateConfig} from '../config.mjs';
import {secretResolver} from '../secrets/resolver.mjs';
import {acquireLock} from '../storage/lock.mjs';
import {createLogger} from '../observability/logger.mjs';
import {errorCode} from '../errors.mjs';
import {configDiagnostic} from '../config-diagnostics.mjs';
import {TelegramClient} from '../telegram/client.mjs';
import {createHouseholdRuntime} from '../household.mjs';
import {ConversationStore} from '../conversation/store.mjs';
import {GlobalDeliveryGate} from '../jobs/runtime.mjs';
import {runMultiBaseLoops} from '../jobs/multi-runtime.mjs';
import {OnboardingStore} from './store.mjs';
import {webSettings} from './settings.mjs';
import {RegistrationService} from './service.mjs';
import {startWebServer} from './http.mjs';
import {privateSender,routeGatewayUpdate} from './gateway.mjs';
import {DashboardAccess} from '../dashboard/access.mjs';
import {DashboardService} from '../dashboard/data.mjs';

export async function main(){
  process.umask(0o077);setDefaultResultOrder('ipv4first');
  const logger=createLogger(),controller=new AbortController(),signal=controller.signal;
  const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const pause=async ms=>{try{await sleep(ms,undefined,{signal});}catch{}};
  const households=new Map(),transitions=new Map();
  let release,store,server,service;
  try{
    const base=await loadConfig(),settings=webSettings(base),resolveSecret=secretResolver(base.secretDir);
    release=acquireLock(base.dataDir);
    const key=Buffer.from((await fs.readFile(settings.keyFile,'utf8')).trim(),'base64');
    store=new OnboardingStore(path.join(settings.dataDir,'registry.sqlite'),key);
    const gate=new GlobalDeliveryGate(store);
    const telegramFor=userId=>new TelegramClient({config:{...base,telegram:{...base.telegram,userId,chatId:userId}},resolveSecret});
    const telegram=telegramFor(base.telegram.userId),botId=(await telegram.getMe()).id;
    const previousBot=store.db.prepare("SELECT value FROM metadata WHERE key='bot_id'").get();
    if(previousBot&&previousBot.value!==String(botId))throw Error('ONBOARDING_BOT_CHANGED');
    store.db.prepare("INSERT OR IGNORE INTO metadata VALUES('bot_id',?)").run(String(botId));
    await telegram.assertPollingAvailable();
    const startRuntime=async(config,{welcome=false,provider,displayName,reconciliation}={})=>{
      const household=createHouseholdRuntime(config),userId=config.telegram.userId,abort=new AbortController();
      household.controlStore.bindTelegramBot(botId);
      const initialDaily=household.runtimes.get(process.env.ONBOARDING_DAILY_BASE);
      if(userId===base.telegram.userId&&initialDaily&&!initialDaily.store.getPreference('daily_reconciliation'))initialDaily.store.setPreference('daily_reconciliation',{enabled:true,time:'09:00',since:Date.now()});
      if(welcome&&reconciliation)household.runtimes.get(config.actual.defaultBase).store.setPreference('daily_reconciliation',{...reconciliation,since:Date.now()});
      if(welcome){
        for(const runtime of household.runtimes.values())new ConversationStore(runtime.store,runtime.config).setProvider(provider);
        household.controlStore.enqueueOutbox({text:`Bem-vindo(a), ${displayName}! Seu orçamento está conectado.\n\nPergunte “quanto gastei este mês?” ou peça uma revisão das categorias. Alterações financeiras disponíveis passam por prévia e confirmação${config.dryRun?' e estão em modo de simulação':''}.\n\nPara guardar contexto: “lembre-se de que ...”. Consulte /memorias e remova com /esquecer ID.\n/cadastro atualiza os acessos; /bases mostra seus orçamentos.`,dedupeKey:`onboarding-welcome:${store.now()}`,suppressBaseFooter:true});
      }
      const entry={...household,abort};households.set(userId,entry);
      entry.task=runMultiBaseLoops({...household,telegram:telegramFor(userId),logger,signal:AbortSignal.any([signal,abort.signal]),pollingEnabled:false,deliveryGate:gate}).catch(error=>{logger('tenant_runtime_failed',{code:errorCode(error)});if(!abort.signal.aborted)controller.abort();});
      return entry;
    };
    const replaceRuntime=async(payload,welcome=false)=>{
      const previous=households.get(payload.userId);
      if(previous){previous.abort.abort();await previous.task;households.delete(payload.userId);await previous.close();}
      const config=await service.materialize(payload);
      return startRuntime(config,{welcome,provider:payload.provider,displayName:payload.displayName,reconciliation:payload.reconciliation});
    };
    const activate=payload=>{
      const task=replaceRuntime(payload,true);transitions.set(payload.userId,task);
      return task.finally(()=>transitions.delete(payload.userId));
    };
    const effectiveConfig=userId=>{
      const household=households.get(userId);if(!household)return null;
      return validateConfig({...household.config,actual:{defaultBase:household.router.selection().alias,bases:household.config.actual.bases}});
    };
    service=new RegistrationService({base,settings,store,activate,effectiveConfig});
    const saved=store.tenants();
    if(!saved.some(p=>p.userId===base.telegram.userId))await startRuntime(base);
    for(const payload of saved)await replaceRuntime(payload);
    if(!store.cursor()){
      const oldCursor=households.get(base.telegram.userId)?.router.cursor()??0;
      if(oldCursor>0)store.advance(oldCursor-1);
    }
    const dashboardAccess=new DashboardAccess(store.db),dashboard=new DashboardService({access:dashboardAccess,getRuntime:id=>households.get(id)});
    server=await startWebServer({service,settings,dashboard});
    logger('onboarding_started');
    const poll=async()=>{
      while(!signal.aborted){
        let updates;try{updates=await telegram.getUpdates(store.cursor(),signal);}catch(error){if(!signal.aborted)logger('poll_failed',{code:errorCode(error),integration:'telegram'});await pause(3000);continue;}
        for(const update of updates){const sender=privateSender(update);if(sender&&transitions.has(sender.userId))await transitions.get(sender.userId).catch(()=>{});routeGatewayUpdate(update,{store,settings,dashboard,getRuntime:id=>households.get(id)});}
        if(!updates.length)await pause(100);
      }
    };
    const deliver=async()=>{
      while(!signal.aborted){
        if(!gate.ready()){await pause(150);continue;}
        const row=store.claimDelivery();if(!row){await pause(150);continue;}
        gate.reserve();
        try{await telegramFor(row.chat_id).sendMessage(row.chat_id,row.payload);store.finishDelivery(row.id,'sent');}
        catch(error){const code=errorCode(error);store.finishDelivery(row.id,code==='TELEGRAM_RATE_LIMITED'?'pending':['TELEGRAM_REJECTED','SECRET_UNAVAILABLE'].includes(code)?'failed':'uncertain');if(code==='TELEGRAM_RATE_LIMITED')gate.defer(error.retryAfterSeconds??60);logger('onboarding_delivery_failed',{code});}
      }
    };
    const maintenance=async()=>{while(!signal.aborted){store.prune();dashboardAccess.prune();await pause(60000);}};
    const guard=fn=>fn().catch(error=>{controller.abort();throw error;});
    const results=await Promise.allSettled([guard(poll),guard(deliver),guard(maintenance)]);
    const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;
  }finally{
    controller.abort();
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await Promise.allSettled([...transitions.values()]);
    for(const entry of households.values()){entry.abort.abort();await entry.task;await entry.close();}
    store?.close();release?.();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    logger('stopped');
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){main().catch(error=>{const detail=configDiagnostic(error);createLogger()('startup_failed',{code:errorCode(error),configField:detail?.field,configReason:detail?.reason});process.exitCode=1;});}
