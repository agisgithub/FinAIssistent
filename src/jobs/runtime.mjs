import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, errorCode } from '../errors.mjs';
import { acceptTelegramUpdate } from '../telegram/ingress.mjs';

export async function processOneJob({ store, handler, telegram, logger, scheduler }) {
  const job = store.claimJob();
  if (!job) return false;
  try {
    if (scheduler?.owns(job)) { await scheduler.runJob(job); return true; }
    if (job.payload.type === 'callback') {
      try { await telegram.answerCallbackQuery(job.payload.callbackId); } catch {}
    }
    const result = await handler(job.payload, job);
    const state = store.db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id)?.state;
    if (state === 'running') store.completeJob(job.id, result);
    else if (state !== 'done') throw new AppError('STORAGE_FAILED');
  } catch (error) {
    if (scheduler?.owns(job)) {
      if (store.db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id)?.state === 'done') return true;
      // Scheduled failures are finalized with policy guards by the scheduler.
      // If its durable commit failed, stop and recover the safe read after restart.
      logger('job_failed', { code: errorCode(error), jobId: job.id });
      throw error;
    }
    const code = errorCode(error);
    store.failJob(job, code);
    logger('job_failed', { code, jobId: job.id });
  }
  return true;
}

export async function processOneDelivery({ store, telegram, logger, scheduler, deliveryGate = null }) {
  scheduler?.tick();
  if (deliveryGate && !deliveryGate.ready()) return false;
  const row = store.claimOutbox();
  if (!row) return false;
  try {
    if (scheduler && !scheduler.authorizeDelivery(row)) { store.finishOutbox(row.id, { state: 'failed' }); return true; }
    deliveryGate?.reserve();
    let messageId;
    if (row.media_type === 'image/png' && row.media_blob) {
      try { messageId = await telegram.sendPhoto(row.chat_id, row.payload, { bytes: row.media_blob, filename: row.media_filename }); }
      catch (error) {
        // A definitive API rejection means no photo was accepted, so the
        // accessible text can safely be delivered once as the fallback.
        if (errorCode(error) !== 'TELEGRAM_REJECTED') throw error;
        messageId = await telegram.sendMessage(row.chat_id, row.payload);
      }
    } else messageId = await telegram.sendMessage(row.chat_id, row.payload);
    store.finishOutbox(row.id, { state: 'sent', messageId });
  } catch (error) {
    const code = errorCode(error, 'DELIVERY_UNCERTAIN');
    if (code === 'TELEGRAM_RATE_LIMITED' && row.attempts < 5 && Number.isSafeInteger(error.retryAfterSeconds)) {
      store.deferOutbox(row.id, error.retryAfterSeconds);
      deliveryGate?.defer(error.retryAfterSeconds);
    }
    else store.finishOutbox(row.id, { state: ['TELEGRAM_REJECTED', 'TELEGRAM_RATE_LIMITED', 'UNAUTHORIZED', 'SECRET_UNAVAILABLE'].includes(code) ? 'failed' : 'uncertain', code });
    logger('delivery_failed', { code, integration: 'telegram' });
  }
  return true;
}

export class GlobalDeliveryGate {
  constructor(store, { key = 'telegram_global_next_send_at', spacingMs = 1100 } = {}) {
    if (!store?.db || !Number.isSafeInteger(spacingMs) || spacingMs < 1000 || spacingMs > 10000) throw new AppError('INPUT_INVALID');
    this.store = store; this.key = key; this.spacingMs = spacingMs;
  }
  next() { return Number(this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(this.key)?.value ?? 0); }
  ready() { return this.store.now() >= this.next(); }
  until(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new AppError('INPUT_INVALID');
    this.store.db.prepare("INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)").run(this.key, String(value));
  }
  reserve() { this.until(this.store.now() + this.spacingMs); }
  defer(seconds) {
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) throw new AppError('INPUT_INVALID');
    this.until(this.store.now() + seconds * 1000);
  }
}

export async function runLoops({ config, store, handler, telegram, logger, scheduler, signal: outerSignal }) {
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
      const worked = await fn({ store, handler, telegram, logger, scheduler });
      if (!worked) await pause(150);
    }
  };
  const maintenance = async () => {
    let ticks = 0;
    while (!signal.aborted) {
      store.heartbeat();
      if (ticks++ % 60 === 0) { store.prune(config.retentionDays); scheduler?.prune(config.retentionDays); }
      await pause(60000);
    }
  };
  const guarded = async fn => { try { return await fn(); } catch (error) { controller.abort(); throw error; } };
  const schedule = async () => {
    while (!signal.aborted) { scheduler.tick(); await pause(30000); }
  };
  // A slow Actual read cannot block accepting updates or delivering messages.
  const results = await Promise.allSettled([guarded(polling), guarded(() => consume(processOneJob)), guarded(() => consume(processOneDelivery)), guarded(maintenance), ...(scheduler ? [guarded(schedule)] : [])]);
  const failure = results.find(r => r.status === 'rejected');
  if (failure) throw failure.reason;
}
