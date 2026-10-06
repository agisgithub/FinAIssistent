import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeUpdate } from '../src/policy/authorize.mjs';
import { acceptTelegramUpdate } from '../src/telegram/ingress.mjs';
import { TelegramClient } from '../src/telegram/client.mjs';
import { createCommandHandler } from '../src/telegram/commands.mjs';
import { processOneJob, processOneDelivery } from '../src/jobs/runtime.mjs';
import { AppError } from '../src/errors.mjs';
import { memoryStore, update, testConfig } from './helpers.mjs';

const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const client = fetchImpl => new TelegramClient({ config: testConfig(), resolveSecret: async () => '123:CANARY_SECRET', fetchImpl });

test('authorization rejects strangers, bots, groups, forwarded messages and cross-user callbacks', t => {
  const { config, store } = memoryStore(t);
  assert.ok(authorizeUpdate(update(1), config));
  for (const bad of [
    update(2, '/status', { from: { id: 999, is_bot: false } }),
    update(3, '/status', { from: { id: 123, is_bot: true } }),
    update(4, '/status', { chat: { id: 123, type: 'group' } }),
    update(5, '/status', { chat: { id: 999, type: 'private' } }),
    update(6, '/status', { forward_origin: { type: 'user' } }),
    update(7, 'x'.repeat(4097)),
    { update_id: 8, callback_query: { id: 'x', data: 'confirm', from: { id: 999, is_bot: false }, message: update(1).message } },
    { update_id: 9, callback_query: { id: 'x', data: 'confirm', from: { id: 123, is_bot: false } } }
  ]) {
    assert.equal(authorizeUpdate(bad, config), null);
    acceptTelegramUpdate(bad, config, store);
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 0);
  const callback = { update_id: 10, callback_query: { id: 'x', data: 'confirm', from: { id: 123, is_bot: false }, message: update(1).message } };
  assert.equal(authorizeUpdate(callback, config).type, 'callback');
});

test('Telegram token stays in its adapter; network error text and authenticated URLs never escape', async () => {
  const telegram = client(async url => { assert.ok(url.includes('CANARY_SECRET')); throw new Error(url); });
  await assert.rejects(telegram.sendMessage(123, { text: 'hello' }), error => error.code === 'DELIVERY_UNCERTAIN' && !error.stack.includes('CANARY_SECRET'));
  await assert.rejects(telegram.getUpdates(0), /NETWORK_FAILED/);
  await assert.rejects(telegram.sendMessage(999, { text: 'hello' }), /UNAUTHORIZED/);
  const rejected = client(async () => response({ ok: false, description: 'CANARY_SECRET' }));
  await assert.rejects(rejected.sendMessage(123, { text: 'hello' }), /TELEGRAM_REJECTED/);
  const broken = client(async () => new Response('CANARY_SECRET', { status: 502 }));
  await assert.rejects(broken.sendMessage(123, { text: 'hello' }), /DELIVERY_UNCERTAIN/);
});

test('getMe binds only bot id and a webhook blocks polling without modifying it', async () => {
  const calls = [];
  const telegram = client(async url => {
    calls.push(url.split('/').at(-1));
    return response({ ok: true, result: url.endsWith('/getMe') ? { id: 999, is_bot: true, username: 'CANARY_SECRET' } : { url: 'https://CANARY_SECRET.example' } });
  });
  assert.deepEqual(await telegram.getMe(), { id: 999 });
  await assert.rejects(telegram.assertPollingAvailable(), /TELEGRAM_WEBHOOK_ACTIVE/);
  assert.deepEqual(calls, ['getMe', 'getWebhookInfo']);
});

test('replayed ingress executes locally once, sends once, and unavailable Actual does not block status', async t => {
  const { store, config } = memoryStore(t);
  const handler = createCommandHandler({ config, store, actual: { snapshot: () => { throw new Error('not configured'); } } });
  let calls = 0;
  const telegram = { sendMessage: async () => ++calls };
  acceptTelegramUpdate(update(1), config, store); acceptTelegramUpdate(update(1), config, store);
  const context = { store, handler, telegram, logger: () => {} };
  assert.equal(await processOneJob(context), true); assert.equal(await processOneJob(context), false);
  assert.equal(await processOneDelivery(context), true); assert.equal(await processOneDelivery(context), false);
  assert.equal(calls, 1);
});

test('incomplete Actual snapshots never produce spending totals and outbox failure never reruns query', async t => {
  const { store, config, identity } = memoryStore(t);
  let reads = 0, deliveredText;
  const handler = createCommandHandler({ config, store, actual: { snapshot: async () => {
    reads++; return { id: 'snapshot', householdId: identity.householdId, budgetId: identity.budgetId, timezone: config.timezone, currency: config.currency, coverage: { complete: false } };
  } } });
  acceptTelegramUpdate(update(1, '/gastos'), config, store);
  const context = { store, handler, telegram: { sendMessage: async (chat, payload) => {
    deliveredText = payload.text; throw new AppError('DELIVERY_UNCERTAIN');
  } }, logger: () => {} };
  await processOneJob(context); await processOneDelivery(context);
  assert.match(deliveredText, /Consulta incompleta/); assert.equal(deliveredText.includes('R$'), false);
  store.recover();
  assert.equal(await processOneJob(context), false); assert.equal(await processOneDelivery(context), false);
  assert.equal(reads, 1); assert.equal(store.status().uncertainDeliveries, 1);
});

test('oversized Telegram response is rejected before payload processing', async () => {
  const telegram = client(async () => new Response('{}', { headers: { 'content-length': '999999999' } }));
  await assert.rejects(telegram.getUpdates(0), /NETWORK_FAILED/);
});

test('explicit 429 schedules bounded retries but ambiguous sends are never retried', async t => {
  let now = 1000;
  const { store } = memoryStore(t, { now: () => now });
  const rateLimited = client(async () => response({ ok: false, error_code: 429, parameters: { retry_after: 2 }, description: 'CANARY_SECRET' }));
  await assert.rejects(rateLimited.sendMessage(123, { text: 'hello' }), error => error.code === 'TELEGRAM_RATE_LIMITED' && error.retryAfterSeconds === 2 && !error.stack.includes('CANARY_SECRET'));
  const invalidDelay = client(async () => response({ ok: false, error_code: 429, parameters: { retry_after: 'CANARY_SECRET' } }));
  await assert.rejects(invalidDelay.sendMessage(123, { text: 'hello' }), /TELEGRAM_REJECTED/);
  store.enqueueOutbox({ text: 'result', dedupeKey: 'rate-limited' });
  const context = { store, telegram: rateLimited, logger: () => {} };
  for (let attempt = 1; attempt <= 5; attempt++) {
    assert.equal(await processOneDelivery(context), true);
    assert.equal(store.db.prepare('SELECT state FROM outbox').get().state, attempt < 5 ? 'pending' : 'failed');
    assert.equal(await processOneDelivery(context), false);
    now += 2000;
  }
  assert.equal(await processOneDelivery(context), false);
});

test('outbox spaces messages to the same chat across claims', t => {
  let now = 1000;
  const { store } = memoryStore(t, { now: () => now });
  store.enqueueOutbox({ text: 'part one', dedupeKey: 'part:1' });
  store.enqueueOutbox({ text: 'part two', dedupeKey: 'part:2' });
  const first = store.claimOutbox();
  store.finishOutbox(first.id, { state: 'sent', messageId: 1 });
  assert.equal(store.claimOutbox(), null);
  now += 1100;
  assert.equal(store.claimOutbox().payload.text, 'part two');
});
