import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

if (isMainThread) {
  test('pinned Actual 26.9.0 reads a synthetic offline budget in an isolated SDK worker', { timeout: 120000 }, async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'finai-sdk-'));
    const worker = new Worker(new URL(import.meta.url), { workerData: { dataDir }, stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume();
    try {
      const result = await new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once('exit', code => { if (code !== 0) reject(new Error(`Synthetic SDK worker exited ${code}`)); });
      });
      assert.equal(result.ok, true, result.code);
      assert.equal(result.sdkVersion, '26.9.0');
      assert.equal(result.networkAttempts, 0);
      assert.equal(result.balance, 9700, 'historical balance excludes the following day');
      assert.equal(result.currentBalance, 9300);
      assert.equal(result.netPeriod, -300, 'split parent is not counted twice');
      assert.equal(result.parents, 1);
      assert.equal(result.children, 2);
      assert.equal(result.incomeBudgeted, null, 'envelope income has no budgeted amount');
      assert.equal(result.expenseCarryover, true);
    } finally {
      await worker.terminate();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
} else {
  // Patch transports before importing the SDK, so even accidental network use
  // fails this synthetic contract test rather than reaching a configured server.
  process.stdout.write = () => true; process.stderr.write = () => true;
  const { default: http } = await import('node:http');
  const { default: https } = await import('node:https');
  const { default: net } = await import('node:net');
  const { syncBuiltinESMExports, createRequire } = await import('node:module');
  let networkAttempts = 0;
  const denyNetwork = () => { networkAttempts++; throw new Error('NETWORK_PROHIBITED_IN_SYNTHETIC_TEST'); };
  http.request = denyNetwork; http.get = denyNetwork;
  https.request = denyNetwork; https.get = denyNetwork;
  net.connect = denyNetwork; net.createConnection = denyNetwork;
  globalThis.fetch = denyNetwork;
  syncBuiltinESMExports();
  const api = await import('@actual-app/api');
  const { ActualExecutor } = await import('../src/actual/executor.mjs');
  const require = createRequire(import.meta.url);
  const sdkVersion = JSON.parse(await readFile(path.resolve(path.dirname(require.resolve('@actual-app/api')), '../package.json'), 'utf8')).version;
  let account, expense, income;
  const sdkAdapter = {
    ...api,
    // Server authentication/download/sync cannot be exercised offline. These
    // lifecycle calls use local creation and a no-op sync; all financial reads
    // below use the pinned real SDK. Fake-SDK tests cover explicit sync failure.
    init: ({ dataDir }) => api.init({ dataDir, verbose: false }),
    sync: async () => {},
    downloadBudget: async () => {
      await api.runImport('FinAIssistent synthetic contract test', async () => {});
      account = await api.createAccount({ name: 'Synthetic account' });
      const group = await api.createCategoryGroup({ name: 'Synthetic expense group' });
      expense = await api.createCategory({ name: 'Synthetic expense', group_id: group });
      income = (await api.getCategories()).find(category => category.is_income).id;
      await api.importTransactions(account, [
        { date: '2026-08-31', amount: 10000, category: income, imported_id: 'synthetic-opening' },
        { date: '2026-09-30', amount: -300, imported_id: 'synthetic-split', subtransactions: [
          { amount: -100, category: expense }, { amount: -200, category: expense }
        ] },
        { date: '2026-10-01', amount: -400, category: expense, imported_id: 'synthetic-next-day' }
      ]);
      await api.setBudgetAmount('2026-09', expense, 500);
      await api.setBudgetCarryover('2026-09', expense, true);
    }
  };
  const executor = new ActualExecutor({
    api: sdkAdapter,
    config: { dataDir: workerData.dataDir, householdId: 'synthetic', timezone: 'America/Sao_Paulo', currency: 'BRL', actual: { budgetId: 'synthetic-local-only', passwordRef: 'synthetic' } },
    resolveSecret: async () => 'synthetic-never-sent'
  });
  try {
    const snapshot = await executor.snapshot({ start: '2026-09-01', end: '2026-09-30' });
    const cutoff = new Date(2026, 9, 1, 12);
    const currentBalance = await api.getAccountBalance(account, cutoff);
    assert.equal(snapshot.coverage.complete, true);
    const month = snapshot.budgetMonths.find(item => item.month === '2026-09');
    const result = {
      ok: true, sdkVersion, networkAttempts, balance: snapshot.accounts[0].balance, currentBalance,
      netPeriod: snapshot.transactions.filter(row => !row.isParent).reduce((sum, row) => sum + row.amount, 0),
      parents: snapshot.transactions.filter(row => row.isParent).length,
      children: snapshot.transactions.filter(row => row.isChild).length,
      incomeBudgeted: month.categories.find(category => category.id === income).budgeted,
      expenseCarryover: month.categories.find(category => category.id === expense).carryover
    };
    await executor.close();
    result.networkAttempts = networkAttempts;
    parentPort.postMessage(result);
  } catch (error) {
    try { await executor.close(); } catch {}
    parentPort.postMessage({ ok: false, code: error.code ?? error.name, networkAttempts });
  }
}
