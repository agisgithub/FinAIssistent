import path from 'node:path';
import { actualProfiles } from './actual/base-registry.mjs';
import { StateStore } from './storage/store.mjs';
import { ActualClient } from './actual/client.mjs';
import { createCommandHandler } from './telegram/commands.mjs';
import { ReportScheduler } from './jobs/scheduler.mjs';
import { BillService } from './application/bills.mjs';
import { BillScheduler } from './jobs/bill-scheduler.mjs';
import { Schedulers } from './jobs/schedulers.mjs';
import { TransactionMonitorScheduler } from './jobs/transaction-monitor.mjs';
import { CategorizationActions } from './application/actions.mjs';
import { CompanionService } from './companion/service.mjs';
import { BaseRouter } from './telegram/base-router.mjs';
import { authorizeUpdate } from './policy/authorize.mjs';
import { loadReviewedPolicy } from './categorization/reviewed-policy.mjs';

export function createHouseholdRuntime(config,{actualFactory=c=>new ActualClient(c),handlerFactory=createCommandHandler}={}) {
  const profiles=actualProfiles(config),runtimes=new Map(),stores=[],actuals=[];
  try {
    for(const profile of profiles) {
      const c={...profile.config,reviewedClassificationPolicy:loadReviewedPolicy(profile.config)},store=new StateStore(path.join(c.dataDir,'state.sqlite'),profile.identity,{conversationConfig:c,baseKey:profile.alias});
      stores.push(store);store.recover();store.prune(c.retentionDays);
      const actual=actualFactory(c,profile.alias,profiles.length);actuals.push(actual);
      const billService=new BillService({config:c,store,actual});
      const reportScheduler=new ReportScheduler({config:c,store,actual,upcomingProvider:o=>billService.getUpcoming(o)});
      const actionService=new CategorizationActions({config:c,store,actual});
      const companionService=new CompanionService({config:c,store,now:()=>new Date(store.now())});
      const transactionMonitor=new TransactionMonitorScheduler({config:c,store,actual,actions:actionService,companionService});
      const scheduler=new Schedulers([reportScheduler,new BillScheduler({config:c,store,service:billService}),transactionMonitor]);
      const handler=handlerFactory({config:c,store,actual,reportScheduler,billService,actionService,companionService,transactionMonitor});
      runtimes.set(profile.alias,{key:profile.alias,alias:profile.alias,config:c,identity:profile.identity,store,actual,handler,scheduler});
    }
    const controlStore=runtimes.get(runtimes.has('principal')?'principal':config.actual.defaultBase)?.store;
    if(!controlStore)throw Error('control runtime unavailable');
    const descriptors=profiles.map(p=>({alias:p.alias,label:p.alias,identity:p.identity,config:p.config}));
    const registry={defaultBase:config.actual.defaultBase,list:()=>descriptors,get:alias=>descriptors.find(p=>p.alias===alias)};
    const router=new BaseRouter({controlStore,registry,runtimes,authorize:update=>authorizeUpdate(update,config)});
    return {config,runtimes,controlStore,router,stores,actuals,async close(){await Promise.allSettled(actuals.map(a=>a?.close?.()));for(const s of stores.reverse())s.close();}};
  } catch(error){for(const a of actuals)void a?.close?.();for(const s of stores.reverse())s.close();throw error;}
}
