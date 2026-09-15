import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { main } from '../src/main.mjs';
import { StateStore } from '../src/storage/store.mjs';
import { identityFromConfig } from '../src/policy/authorize.mjs';
import { tempDirectory, testConfig, update } from './helpers.mjs';

test('runnable main accepts and delivers a synthetic command then releases its process lock', { timeout: 5000 }, async t => {
  const config = testConfig(tempDirectory(t));
  const controller = new AbortController();
  const events = [], deliveries = [];
  let polled = false, closed = false;
  const telegram = {
    getMe: async () => ({ id: 777 }), assertPollingAvailable: async () => {},
    getUpdates: async () => { if (polled) return []; polled = true; return [update(1), update(1), update(2, '/status', { from: { id: 999, is_bot: false } })]; },
    sendMessage: async (chatId, payload) => { deliveries.push({ chatId, payload }); controller.abort(); return 22; }
  };
  await main({ config, telegram, actual: { close: async () => { closed = true; } }, signal: controller.signal, logger: event => events.push(event) });
  assert.equal(closed, true); assert.equal(deliveries.length, 1); assert.equal(deliveries[0].chatId, 123);
  assert.deepEqual(events, ['started', 'stopped']);
  const store = new StateStore(path.join(config.dataDir, 'state.sqlite'), identityFromConfig(config));
  assert.equal(store.cursor(), 3); assert.equal(store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE state='sent'").get().n, 1); store.close();
});
