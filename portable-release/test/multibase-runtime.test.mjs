import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AppError } from '../src/errors.mjs';
import { StateStore } from '../src/storage/store.mjs';
import { GlobalDeliveryGate, processOneDelivery } from '../src/jobs/runtime.mjs';
import { runMultiBaseLoops } from '../src/jobs/multi-runtime.mjs';
import { tempDirectory } from './helpers.mjs';

const identity = budgetId => ({ householdId: 'home', budgetId, userId: 123, chatId: 123, timezone: 'America/Sao_Paulo', currency: 'BRL' });

test('profile outbox carries a bounded base marker without changing legacy stores', t => {
  const legacy = new StateStore(':memory:', identity('legacy'));
  const profile = new StateStore(':memory:', identity('profile'), { baseKey: 'financa-hml2' });
  t.after(() => { legacy.close(); profile.close(); });
  legacy.enqueueOutbox({ text: 'resultado', dedupeKey: 'legacy' });
  profile.enqueueOutbox({ text: 'resultado', dedupeKey: 'profile' });
  assert.equal(legacy.claimOutbox().payload.text, 'resultado');
  assert.equal(profile.claimOutbox().payload.text, 'resultado\n\nBase: financa-hml2');
});

test('one durable delivery gate serializes independent profile outboxes', async t => {
  let now = 1000;
  const control = new StateStore(':memory:', identity('principal'), { now: () => now, baseKey: 'principal' });
  const other = new StateStore(':memory:', identity('hml'), { now: () => now, baseKey: 'financa-hml2' });
  t.after(() => { control.close(); other.close(); });
  control.enqueueOutbox({ text: 'um', dedupeKey: 'one' });
  other.enqueueOutbox({ text: 'dois', dedupeKey: 'two' });
  const sent = [], telegram = { sendMessage: async (_chat, payload) => { sent.push(payload.text); return sent.length; } };
  const gate = new GlobalDeliveryGate(control), logger = () => {};
  assert.equal(await processOneDelivery({ store: control, telegram, logger, deliveryGate: gate }), true);
  assert.equal(await processOneDelivery({ store: other, telegram, logger, deliveryGate: gate }), false);
  now += 1100;
  assert.equal(await processOneDelivery({ store: other, telegram, logger, deliveryGate: gate }), true);
  assert.deepEqual(sent, ['um\n\nBase: principal', 'dois\n\nBase: financa-hml2']);
});

test('a blocked HML job cannot hold the principal job consumer', { timeout: 5000 }, async t => {
  let now = 1000, releaseHml;
  const hmlBlocked = new Promise(resolve => { releaseHml = resolve; });
  const principal = new StateStore(':memory:', identity('principal'), { now: () => now, baseKey: 'principal' });
  const hml = new StateStore(':memory:', identity('hml'), { now: () => now, baseKey: 'financa-hml2' });
  t.after(() => { principal.close(); hml.close(); });
  const payload = store => ({ type: 'message', text: '/status', identity: store.identity });
  hml.enqueueJob({ kind: 'command', payload: payload(hml), dedupeKey: 'hml-command' });
  principal.enqueueJob({ kind: 'command', payload: payload(principal), dedupeKey: 'principal-command' });
  const controller = new AbortController(), sent = [];
  const runtimes = [
    { key: 'financa-hml2', store: hml, config: { retentionDays: 90 }, handler: async () => { await hmlBlocked; return { text: 'hml', dedupeKey: 'hml-result' }; } },
    { key: 'principal', store: principal, config: { retentionDays: 90 }, handler: async () => ({ text: 'principal', dedupeKey: 'principal-result' }) }
  ];
  const router = { cursor: () => 0, accept: () => {}, forwardOne: async () => false, prune: () => {} };
  const telegram = {
    getUpdates: async () => [], answerCallbackQuery: async () => {},
    sendMessage: async (_chat, message) => {
      sent.push(message.text);
      if (/^principal/.test(message.text)) { now += 1100; releaseHml(); }
      if (sent.length === 2) controller.abort();
      return sent.length;
    }
  };
  await runMultiBaseLoops({ config: { retentionDays: 90 }, controlStore: principal, router, runtimes, telegram, logger: () => {}, signal: controller.signal });
  assert.deepEqual(sent, ['principal\n\nBase: principal', 'hml\n\nBase: financa-hml2']);
});

test('Telegram polling retries network errors but propagates durable router failures', { timeout: 7000 }, async t => {
  const store = new StateStore(':memory:', identity('principal'), { baseKey: 'principal' });
  t.after(() => store.close());
  const runtime = { key: 'principal', store, config: { retentionDays: 90 }, handler: async () => null };
  const events = [], routerFailure = new Error('ROUTER_DURABILITY_FATAL_CANARY');
  let polls = 0;
  const telegram = {
    getUpdates: async () => {
      if (++polls === 1) throw new AppError('NETWORK_FAILED');
      return [{ update_id: 1 }];
    },
    sendMessage: async () => 1,
    answerCallbackQuery: async () => {}
  };
  const router = {
    cursor: () => 0,
    accept: () => { throw routerFailure; },
    forwardOne: async () => false,
    prune: () => {}
  };
  await assert.rejects(
    runMultiBaseLoops({ config: { retentionDays: 90 }, controlStore: store, router, runtimes: [runtime], telegram, logger: (event, detail) => events.push({ event, detail }), signal: new AbortController().signal }),
    error => error === routerFailure
  );
  assert.equal(polls, 2);
  assert.deepEqual(events, [{ event: 'poll_failed', detail: { code: 'NETWORK_FAILED', integration: 'telegram' } }]);
});

test('an escaped scheduler failure aborts loops and restart recovery requeues the running safe job', { timeout: 5000 }, async t => {
  const root = tempDirectory(t), filename = path.join(root, 'scheduler.sqlite'), owner = identity('principal');
  let store = new StateStore(filename, owner, { baseKey: 'principal' });
  t.after(() => { try { store.close(); } catch {} });
  store.enqueueJob({ kind: 'scheduled-test', payload: { scheduled: true }, dedupeKey: 'scheduled-fatal', safeRetry: true });
  const scheduler = {
    owns: () => true,
    runJob: async () => { throw new Error('SCHEDULER_FATAL_CANARY'); },
    tick() {}, prune() {}, authorizeDelivery: () => true
  };
  const runtime = { key: 'principal', store, config: { retentionDays: 90 }, handler: async () => null, scheduler };
  const router = { cursor: () => 0, accept: () => {}, forwardOne: async () => false, prune: () => {} };
  const telegram = { getUpdates: async () => [], sendMessage: async () => 1, answerCallbackQuery: async () => {} };
  await assert.rejects(
    runMultiBaseLoops({ config: { retentionDays: 90 }, controlStore: store, router, runtimes: [runtime], telegram, logger: () => {}, signal: new AbortController().signal }),
    /SCHEDULER_FATAL_CANARY/
  );
  assert.equal(store.db.prepare("SELECT state FROM jobs WHERE dedupe_key='scheduled-fatal'").get().state, 'running');
  store.close();
  store = new StateStore(filename, owner, { baseKey: 'principal' });
  store.recover();
  assert.equal(store.db.prepare("SELECT state FROM jobs WHERE dedupe_key='scheduled-fatal'").get().state, 'queued');
  store.close();
});

test('an escaped delivery commit failure aborts loops and restart recovery marks sending uncertain', { timeout: 5000 }, async t => {
  const root = tempDirectory(t), filename = path.join(root, 'delivery.sqlite'), owner = identity('principal');
  let store = new StateStore(filename, owner, { baseKey: 'principal' });
  t.after(() => { try { store.close(); } catch {} });
  store.enqueueOutbox({ text: 'resultado', dedupeKey: 'delivery-fatal' });
  store.finishOutbox = () => { throw new Error('DELIVERY_COMMIT_FATAL_CANARY'); };
  const runtime = { key: 'principal', store, config: { retentionDays: 90 }, handler: async () => null };
  const router = { cursor: () => 0, accept: () => {}, forwardOne: async () => false, prune: () => {} };
  const telegram = { getUpdates: async () => [], sendMessage: async () => 1, answerCallbackQuery: async () => {} };
  await assert.rejects(
    runMultiBaseLoops({ config: { retentionDays: 90 }, controlStore: store, router, runtimes: [runtime], telegram, logger: () => {}, signal: new AbortController().signal }),
    /DELIVERY_COMMIT_FATAL_CANARY/
  );
  assert.equal(store.db.prepare("SELECT state FROM outbox WHERE dedupe_key='delivery-fatal'").get().state, 'sending');
  store.close();
  store = new StateStore(filename, owner, { baseKey: 'principal' });
  store.recover();
  const recovered = store.db.prepare("SELECT state,error_code FROM outbox WHERE dedupe_key='delivery-fatal'").get();
  assert.deepEqual(recovered, { state: 'uncertain', error_code: 'DELIVERY_UNCERTAIN' });
  store.close();
});
