import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { main } from '../src/main.mjs';
import { validateConfig } from '../src/config.mjs';
import { StateStore } from '../src/storage/store.mjs';
import { actualProfileConfig, actualProfileIdentity } from '../src/actual/base-registry.mjs';
import { inputConfig, tempDirectory, update } from './helpers.mjs';

test('two runtimes isolate state and an unavailable HML Actual does not stop principal chat', { timeout: 12000 }, async t => {
  const root = tempDirectory(t), input = inputConfig();
  input.dataDir = './data'; input.secretDir = './secrets';
  input.companion = { enabled: true, transactionMonitorEnabled: false, autoCategorizeHighConfidence: false };
  input.actual = { defaultBase: 'principal', bases: {
    principal: { serverURL: 'http://actual-principal.invalid', budgetId: 'principal-budget', passwordRef: 'actual-password' },
    'financa-hml2': { serverURL: 'http://actual-hml.invalid', budgetId: 'hml-budget', passwordRef: 'actual-password' }
  } };
  const config = validateConfig(input, root), controller = new AbortController(), deliveries = [], closed = [];
  let polled = false, releaseHml;
  const hmlBlocked = new Promise(resolve => { releaseHml = resolve; });
  const telegram = {
    getMe: async () => ({ id: 777 }), assertPollingAvailable: async () => {}, answerCallbackQuery: async () => {},
    getUpdates: async () => { if (polled) return []; polled = true; return [
      update(1, '/base usar financa-hml2'), update(2, '/gastos hoje'), update(3, '/base usar principal'), update(4, '/status')
    ]; },
    sendMessage: async (_chat, payload) => {
      deliveries.push(payload.text);
      // The principal response must be able to complete while HML is still
      // blocked in its own Actual call. Releasing HML here deadlocks the old
      // single-consumer design and therefore proves queue isolation.
      if (/FINAISSISTENT · EM EXECUÇÃO/.test(payload.text)) releaseHml();
      if (deliveries.length >= 4) controller.abort();
      return deliveries.length;
    }
  };
  const actuals = new Map([
    ['principal', { close: async () => { closed.push('principal'); } }],
    ['financa-hml2', { snapshot: async () => { await hmlBlocked; throw new Error('HML_CANARY_FAILURE'); }, close: async () => { closed.push('financa-hml2'); } }]
  ]);
  await main({ config, telegram, actual: actuals, signal: controller.signal, logger: () => {} });
  assert.deepEqual(new Set(closed), new Set(['principal','financa-hml2']));
  assert.ok(deliveries.some(text => /Base alterada para financa-hml2/.test(text)));
  assert.ok(deliveries.some(text => /Base alterada para principal/.test(text)));
  assert.ok(deliveries.some(text => /Base: financa-hml2$/.test(text)));
  assert.ok(deliveries.some(text => /FINAISSISTENT · EM EXECUÇÃO/.test(text) && /Base: principal$/.test(text)));
  const principalConfig = actualProfileConfig(config, 'principal'), hmlConfig = actualProfileConfig(config, 'financa-hml2');
  assert.equal(path.dirname(path.join(principalConfig.dataDir, 'state.sqlite')), config.dataDir);
  assert.equal(path.dirname(path.join(hmlConfig.dataDir, 'state.sqlite')), path.join(config.dataDir, 'bases', 'financa-hml2'));
  const principal = new StateStore(path.join(principalConfig.dataDir, 'state.sqlite'), actualProfileIdentity(config, 'principal'));
  const hml = new StateStore(path.join(hmlConfig.dataDir, 'state.sqlite'), actualProfileIdentity(config, 'financa-hml2'));
  try {
    assert.equal(principal.db.prepare("SELECT active_alias FROM base_route_selections").get().active_alias, 'principal');
    assert.equal(hml.db.prepare("SELECT COUNT(*) n FROM jobs WHERE dedupe_key LIKE 'telegram-router:%'").get().n, 1);
    assert.equal(principal.db.prepare("SELECT COUNT(*) n FROM jobs WHERE dedupe_key LIKE 'telegram-router:%'").get().n, 1);
  } finally { hml.close(); principal.close(); }
});
