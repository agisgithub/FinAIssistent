import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { identityFromConfig } from './policy/authorize.mjs';
import { StateStore } from './storage/store.mjs';
import { acquireLock } from './storage/lock.mjs';
import { secretResolver } from './secrets/resolver.mjs';
import { createLogger } from './observability/logger.mjs';
import { errorCode } from './errors.mjs';
import { TelegramClient } from './telegram/client.mjs';
import { ActualClient } from './actual/client.mjs';
import { createCommandHandler } from './telegram/commands.mjs';
import { runLoops } from './jobs/runtime.mjs';

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
    store = new StateStore(path.join(config.dataDir, 'state.sqlite'), identityFromConfig(config));
    store.recover();
    store.prune(config.retentionDays);
    const resolveSecret = secretResolver(config.secretDir);
    const telegram = injectedTelegram ?? new TelegramClient({ config, resolveSecret });
    store.bindTelegramBot((await telegram.getMe()).id);
    await telegram.assertPollingAvailable();
    actual = injectedActual ?? new ActualClient(config);
    const handler = handlerFactory({ config, store, actual });
    logger('started');
    await runLoops({ config, store, handler, telegram, logger, signal });
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
  main().catch(error => { createLogger()('startup_failed', { code: errorCode(error) }); process.exitCode = 1; });
}
