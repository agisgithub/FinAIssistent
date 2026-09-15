import { setTimeout as sleep } from 'node:timers/promises';
import { errorCode } from '../errors.mjs';
import { acceptTelegramUpdate } from '../telegram/ingress.mjs';

export async function processOneJob({ store, handler, telegram, logger }) {
  const job = store.claimJob();
  if (!job) return false;
  try {
    if (job.payload.type === 'callback') {
      try { await telegram.answerCallbackQuery(job.payload.callbackId); } catch {}
    }
    const result = await handler(job.payload, job);
    store.completeJob(job.id, result);
  } catch (error) {
    const code = errorCode(error);
    store.failJob(job, code);
    logger('job_failed', { code, jobId: job.id });
  }
  return true;
}

export async function processOneDelivery({ store, telegram, logger }) {
  const row = store.claimOutbox();
  if (!row) return false;
  try {
    const messageId = await telegram.sendMessage(row.chat_id, row.payload);
    store.finishOutbox(row.id, { state: 'sent', messageId });
  } catch (error) {
    const code = errorCode(error, 'DELIVERY_UNCERTAIN');
    if (code === 'TELEGRAM_RATE_LIMITED' && row.attempts < 5 && Number.isSafeInteger(error.retryAfterSeconds)) store.deferOutbox(row.id, error.retryAfterSeconds);
    else store.finishOutbox(row.id, { state: ['TELEGRAM_REJECTED', 'TELEGRAM_RATE_LIMITED', 'UNAUTHORIZED', 'SECRET_UNAVAILABLE'].includes(code) ? 'failed' : 'uncertain', code });
    logger('delivery_failed', { code, integration: 'telegram' });
  }
  return true;
}

export async function runLoops({ config, store, handler, telegram, logger, signal: outerSignal }) {
  const controller = new AbortController();
  const signal = AbortSignal.any([outerSignal, controller.signal]);
  const pause = async ms => { try { await sleep(ms, undefined, { signal }); } catch {} };
  const polling = async () => {
    while (!signal.aborted) {
      try {
        const updates = await telegram.getUpdates(store.cursor(), signal);
        for (const update of updates) acceptTelegramUpdate(update, config, store);
        if (!updates.length) await pause(50);
      } catch (error) {
        if (!signal.aborted) logger('poll_failed', { code: errorCode(error), integration: 'telegram' });
        await pause(3000);
      }
    }
  };
  const consume = async fn => {
    while (!signal.aborted) {
      const worked = await fn({ store, handler, telegram, logger });
      if (!worked) await pause(150);
    }
  };
  const maintenance = async () => {
    let ticks = 0;
    while (!signal.aborted) {
      store.heartbeat();
      if (ticks++ % 60 === 0) store.prune(config.retentionDays);
      await pause(60000);
    }
  };
  const guarded = async fn => { try { return await fn(); } catch (error) { controller.abort(); throw error; } };
  // A slow Actual read cannot block accepting updates or delivering messages.
  const results = await Promise.allSettled([guarded(polling), guarded(() => consume(processOneJob)), guarded(() => consume(processOneDelivery)), guarded(maintenance)]);
  const failure = results.find(r => r.status === 'rejected');
  if (failure) throw failure.reason;
}
