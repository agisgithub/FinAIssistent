import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { authorizeUpdate } from './policy/authorize.mjs';
import { actualProfiles } from './actual/base-registry.mjs';
import { StateStore } from './storage/store.mjs';
import { acquireLock } from './storage/lock.mjs';
import { secretResolver } from './secrets/resolver.mjs';
import { createLogger } from './observability/logger.mjs';
import { errorCode } from './errors.mjs';
import { configDiagnostic } from './config-diagnostics.mjs';
import { TelegramClient } from './telegram/client.mjs';
import { ActualClient } from './actual/client.mjs';
import { createCommandHandler } from './telegram/commands.mjs';
import { runMultiBaseLoops } from './jobs/multi-runtime.mjs';
import { ReportScheduler } from './jobs/scheduler.mjs';
import { BillService } from './application/bills.mjs';
import { BillScheduler } from './jobs/bill-scheduler.mjs';
import { Schedulers } from './jobs/schedulers.mjs';
import { TransactionMonitorScheduler } from './jobs/transaction-monitor.mjs';
import { CategorizationActions } from './application/actions.mjs';
import { CompanionService } from './companion/service.mjs';
import { BaseRouter } from './telegram/base-router.mjs';

function injectedActualFor(injected, alias, count) {
  if (!injected) return null;
  if (injected instanceof Map) return injected.get(alias) ?? null;
  if (count > 1 && Object.hasOwn(injected, alias)) return injected[alias];
  return count === 1 ? injected : null;
}

export async function main({ config: injectedConfig, actual: injectedActual, telegram: injectedTelegram, signal: injectedSignal, logger = createLogger(), handlerFactory = createCommandHandler } = {}) {
  process.umask(0o077);
  const controller = new AbortController();
  const stop = () => controller.abort();
  const signal = injectedSignal ? AbortSignal.any([injectedSignal, controller.signal]) : controller.signal;
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let releaseLock;
  const stores = [], actuals = [];
  try {
    const config = injectedConfig ?? await loadConfig();
    releaseLock = acquireLock(config.dataDir);
    const profiles = actualProfiles(config), runtimes = new Map();
    const resolveSecret = secretResolver(config.secretDir);
    const telegram = injectedTelegram ?? new TelegramClient({ config, resolveSecret });
    for (const profile of profiles) {
      const profileConfig = profile.config;
      const store = new StateStore(path.join(profileConfig.dataDir, 'state.sqlite'), profile.identity, { conversationConfig: profileConfig, baseKey: profile.alias });
      stores.push(store); store.recover(); store.prune(profileConfig.retentionDays);
      const actual = injectedActualFor(injectedActual, profile.alias, profiles.length) ?? new ActualClient(profileConfig);
      actuals.push(actual);
      const billService = new BillService({ config: profileConfig, store, actual });
      const reportScheduler = new ReportScheduler({ config: profileConfig, store, actual, upcomingProvider: options => billService.getUpcoming(options) });
      const actionService = new CategorizationActions({ config: profileConfig, store, actual });
      const companionService = new CompanionService({ config: profileConfig, store, now: () => new Date(store.now()) });
      const transactionMonitor = new TransactionMonitorScheduler({ config: profileConfig, store, actual, actions: actionService, companionService });
      const scheduler = new Schedulers([reportScheduler,new BillScheduler({ config: profileConfig, store, service: billService }),transactionMonitor]);
      const handler = handlerFactory({ config: profileConfig, store, actual, reportScheduler, billService, actionService, companionService, transactionMonitor });
      runtimes.set(profile.alias, { key: profile.alias, alias: profile.alias, config: profileConfig, identity: profile.identity, store, actual, handler, scheduler });
    }
    const controlAlias = runtimes.has('principal') ? 'principal' : config.actual.defaultBase;
    const controlStore = runtimes.get(controlAlias)?.store;
    if (!controlStore) throw new Error('control runtime unavailable');
    controlStore.bindTelegramBot((await telegram.getMe()).id);
    await telegram.assertPollingAvailable();
    const descriptors = profiles.map(profile => ({ alias: profile.alias, label: profile.alias, identity: profile.identity, config: profile.config }));
    const registry = { defaultBase: config.actual.defaultBase, list: () => descriptors, get: alias => descriptors.find(profile => profile.alias === alias) };
    const router = new BaseRouter({ controlStore, registry, runtimes, authorize: update => authorizeUpdate(update, config) });
    logger('started');
    await runMultiBaseLoops({ config, controlStore, router, runtimes, telegram, logger, signal });
  } finally {
    controller.abort();
    try { await Promise.allSettled(actuals.map(actual => actual?.close?.())); } finally {
      for (const store of stores.reverse()) store.close();
      releaseLock?.();
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      logger('stopped');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    const detail = configDiagnostic(error);
    createLogger()('startup_failed', { code: errorCode(error), configField: detail?.field, configReason: detail?.reason });
    process.exitCode = 1;
  });
}
