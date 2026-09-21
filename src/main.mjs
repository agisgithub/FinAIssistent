import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { identityFromConfig } from './policy/authorize.mjs';
import { StateStore } from './storage/store.mjs';
import { acquireLock } from './storage/lock.mjs';
import { secretResolver } from './secrets/resolver.mjs';
import { createLogger } from './observability/logger.mjs';
import { errorCode } from './errors.mjs';
import { configDiagnostic } from './config-diagnostics.mjs';
import { TelegramClient } from './telegram/client.mjs';
import { ActualClient } from './actual/client.mjs';
import { createCommandHandler } from './telegram/commands.mjs';
import { runLoops } from './jobs/runtime.mjs';
import { ReportScheduler } from './jobs/scheduler.mjs';
import { BillService } from './application/bills.mjs';
import { BillScheduler } from './jobs/bill-scheduler.mjs';
import { Schedulers } from './jobs/schedulers.mjs';
import { TransactionMonitorScheduler } from './jobs/transaction-monitor.mjs';
import { CategorizationActions } from './application/actions.mjs';
import { CompanionService } from './companion/service.mjs';

export async function main({ config: injectedConfig, actual: injectedActual, telegram: injectedTelegram, signal: injectedSignal, logger = createLogger(), handlerFactory = createCommandHandler } = {}) {
  process.umask(0o077);
  const controller = new AbortController();
  const stop = () => controller.abort();
  const signal = injectedSignal ? AbortSignal.any([injectedSignal, controller.signal]) : controller.signal;
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let releaseLock, store, actual;
  try {
    const config = injectedConfig ?? await loadConfig();
    releaseLock = acquireLock(config.dataDir);
    store = new StateStore(path.join(config.dataDir, 'state.sqlite'), identityFromConfig(config), { conversationConfig: config });
    store.recover();
    store.prune(config.retentionDays);
    const resolveSecret = secretResolver(config.secretDir);
    const telegram = injectedTelegram ?? new TelegramClient({ config, resolveSecret });
    store.bindTelegramBot((await telegram.getMe()).id);
    await telegram.assertPollingAvailable();
    actual = injectedActual ?? new ActualClient(config);
    const billService = new BillService({ config, store, actual });
    const reportScheduler = new ReportScheduler({ config, store, actual, upcomingProvider: options => billService.getUpcoming(options) });
    const actionService = new CategorizationActions({ config, store, actual });
    const companionService = new CompanionService({ config, store, now: () => new Date(store.now()) });
    const transactionMonitor = new TransactionMonitorScheduler({ config, store, actual, actions: actionService, companionService });
    const scheduler = new Schedulers([reportScheduler,new BillScheduler({ config, store, service: billService }),transactionMonitor]);
    const handler = handlerFactory({ config, store, actual, reportScheduler, billService, actionService, companionService, transactionMonitor });
    logger('started');
    await runLoops({ config, store, handler, telegram, logger, scheduler, signal });
  } finally {
    controller.abort();
    try { await actual?.close(); } finally {
      store?.close();
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
