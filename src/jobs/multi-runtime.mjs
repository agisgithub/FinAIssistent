import { setTimeout as sleep } from 'node:timers/promises';
import { errorCode } from '../errors.mjs';
import { GlobalDeliveryGate, processOneDelivery, processOneJob } from './runtime.mjs';

function normalizedRuntimes(runtimes) {
  const values = runtimes instanceof Map ? [...runtimes.values()] : Array.isArray(runtimes) ? runtimes : Object.values(runtimes ?? {});
  if (!values.length || values.some(runtime => !runtime?.key || !runtime.store || !runtime.handler || !runtime.config)) throw new TypeError('invalid runtimes');
  return values;
}

// One Telegram poller feeds isolated per-base runtimes. Financial failures are
// contained to their runtime; failure of the durable router stops the process
// so its pending ledger can be recovered before another update is accepted.
export async function runMultiBaseLoops({ config, controlStore, router, runtimes, telegram, logger, signal: outerSignal }) {
  const list = normalizedRuntimes(runtimes), controller = new AbortController();
  const signal = AbortSignal.any([outerSignal, controller.signal]);
  const gate = new GlobalDeliveryGate(controlStore);
  let deliveryCursor = 0;
  const pause = async ms => { try { await sleep(ms, undefined, { signal }); } catch {} };
  const fatal = async (runtime, operation, fn) => {
    try { return await fn(); }
    catch (error) { logger('runtime_failed', { code: errorCode(error), base: runtime.key, operation }); throw error; }
  };
  const polling = async () => {
    while (!signal.aborted) {
      let updates;
      try {
        updates = await telegram.getUpdates(router.cursor(), signal);
      } catch (error) {
        if (!signal.aborted) logger('poll_failed', { code: errorCode(error), integration: 'telegram' });
        await pause(3000);
        continue;
      }
      for (const update of updates) router.accept(update);
      if (!updates.length) await pause(50);
    }
  };
  const forwarding = async () => {
    while (!signal.aborted) {
      const worked = await router.forwardOne();
      if (!worked) await pause(100);
    }
  };
  const consumeJobs = async runtime => {
    while (!signal.aborted) {
      const worked = await fatal(runtime, 'job', () => processOneJob({ ...runtime, telegram, logger }));
      if (!worked) await pause(150);
    }
  };
  const consumeDeliveries = async () => {
    while (!signal.aborted) {
      let worked = false;
      for (let offset = 0; offset < list.length; offset++) {
        const index = (deliveryCursor + offset) % list.length, runtime = list[index];
        if (await fatal(runtime, 'delivery', () => processOneDelivery({ ...runtime, telegram, logger, deliveryGate: gate }))) {
          deliveryCursor = (index + 1) % list.length; worked = true; break;
        }
      }
      if (!worked) await pause(150);
    }
  };
  const maintenance = async () => {
    let ticks = 0;
    while (!signal.aborted) {
      for (const runtime of list) await fatal(runtime, 'maintenance', async () => {
        runtime.store.heartbeat();
        if (ticks % 60 === 0) { runtime.store.prune(runtime.config.retentionDays); runtime.scheduler?.prune(runtime.config.retentionDays); }
        return true;
      });
      if (ticks++ % 60 === 0) router.prune?.(config.retentionDays);
      await pause(60000);
    }
  };
  const schedule = async () => {
    while (!signal.aborted) {
      for (const runtime of list) await fatal(runtime, 'scheduler', async () => { runtime.scheduler?.tick(); return true; });
      await pause(30000);
    }
  };
  const guarded = async fn => { try { return await fn(); } catch (error) { controller.abort(); throw error; } };
  // Each Actual profile owns a job consumer. A slow or failed SDK call in one
  // profile must not hold the queue of another profile; Telegram delivery stays
  // globally serialized by consumeDeliveries and its durable gate.
  const results = await Promise.allSettled([
    guarded(polling), guarded(forwarding),
    ...list.map(runtime => guarded(() => consumeJobs(runtime))),
    guarded(consumeDeliveries), guarded(maintenance), guarded(schedule)
  ]);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}
