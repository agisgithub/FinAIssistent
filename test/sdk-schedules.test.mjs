import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { tempDirectory } from './helpers.mjs';

if (isMainThread) {
  test('pinned SDK schedule shapes, completed/deleted catalog and transaction metadata survive the guarded adapter', { timeout: 60000 }, async t => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { dataDir: tempDirectory(t) }, stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume();
    const timer = setTimeout(() => { void worker.terminate(); }, 45000);
    try {
      const result = await new Promise((resolve, reject) => {
        let result;
        worker.once('message', message => { result = message; }); worker.once('error', reject);
        worker.once('exit', code => code === 0 && result ? resolve(result) : reject(new Error('Synthetic schedule worker exited without clean result')));
      });
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result, { ok: true, networkAttempts: 0, schedules: 7, uncommonRulesPreserved: true, completedIncluded: true, deletedExcluded: true, metadataFingerprintsMatch: true, openingExcluded: true, noPaidInference: true });
    } finally { clearTimeout(timer); await worker.terminate(); }
  });
} else {
  process.stdout.write = () => true; process.stderr.write = () => true;
  const { default: http } = await import('node:http'), { default: https } = await import('node:https'), { default: net } = await import('node:net');
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const { default: path } = await import('node:path');
  const RealDate = Date, now = new Date(2026, 8, 15, 12).getTime();
  globalThis.Date = class FixtureDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  let networkAttempts = 0;
  const deny = () => { networkAttempts++; throw new Error('SYNTHETIC_NETWORK_BLOCKED'); };
  http.request = deny; http.get = deny; https.request = deny; https.get = deny;
  net.connect = deny; net.createConnection = deny; globalThis.fetch = deny; syncBuiltinESMExports();
  const { loadPinnedActual } = await import('../src/actual/sdk-loader.mjs');
  const api = await loadPinnedActual();
  const { ActualExecutor } = await import('../src/actual/executor.mjs');
  const { transactionFingerprint } = await import('../src/actual/transaction.mjs');
  const Database = createRequire(import.meta.url)('better-sqlite3');
  const config = { dataDir: workerData.dataDir, householdId: 'synthetic', timezone: 'America/Sao_Paulo', currency: 'BRL', actual: { budgetId: 'synthetic-budget', passwordRef: 'synthetic-password' } };
  const ids = {}, cases = {};
  let account;
  const executor = new ActualExecutor({ config, resolveSecret: async () => 'synthetic-not-sent', api: {
    ...api,
    init: ({ dataDir }) => api.init({ dataDir, verbose: false }), sync: async () => {},
    // Offline creation replaces remote download only. The separate safety test
    // exercises real init/download/sync with an in-memory protocol response.
    downloadBudget: async () => {
      await api.runImport('Synthetic schedule catalog', async () => {});
      account = await api.createAccount({ name: 'Synthetic schedule account' }, 5000);
      const payee = await api.createPayee({ name: 'Synthetic schedule payee' });
      const closedAccount = await api.createAccount({ name: 'Synthetic closed schedule account', closed: true });
      const common = { account, payee, amount: -10000, amountOp: 'is', posts_transaction: false };
      Object.assign(cases, {
        fixed: { ...common, name: 'Synthetic fixed', date: '2050-01-31', posts_transaction: true },
        month: { ...common, name: 'Synthetic month', amountOp: 'isapprox', date: { frequency: 'monthly', interval: 1, start: '2050-01-31', endMode: 'after_n_occurrences', endOccurrences: 3, patterns: [{ type: 'day', value: 31 }], skipWeekend: true, weekendSolveMode: 'before' } },
        week: { ...common, name: 'Synthetic range', amountOp: 'isbetween', amount: { num1: -15000, num2: -5000 }, date: { frequency: 'weekly', interval: 2, start: '2050-01-01', endMode: 'on_date', endDate: '2050-12-31' } },
        year: { ...common, name: 'Synthetic yearly', date: { frequency: 'yearly', start: '2052-02-29', endMode: 'never' } },
        last: { ...common, name: 'Synthetic last day', date: { frequency: 'monthly', start: '2050-01-01', patterns: [{ type: 'day', value: -1 }, { type: 'MO', value: -1 }] } },
        omitted: { amountOp: 'is', date: { frequency: 'daily', start: '2050-01-01' }, posts_transaction: false },
        completed: { ...common, name: 'Synthetic completed', account: closedAccount, date: '2050-02-01' },
        deleted: { ...common, name: 'Synthetic deleted', date: '2050-03-01' }
      });
      for (const [key, input] of Object.entries(cases)) ids[key] = await api.createSchedule(input);
      await api.deleteSchedule(ids.deleted);
      await api.addTransactions(account, [{ date: '2026-09-15', amount: -1234, payee, notes: 'Synthetic reconciled schedule link', cleared: true, reconciled: true, schedule: ids.fixed }]);
      // Prepare a persisted completed row as if it came from another client.
      // There is deliberately no invented public set-completed API. This local
      // SQLite fixture touches only the disposable test budget, not SDK files.
      const localId = (await api.getBudgets())[0].id;
      const db = new Database(path.join(workerData.dataDir, 'actual', localId, 'db.sqlite'));
      try { assert.equal(db.prepare('UPDATE schedules SET completed=1 WHERE id=?').run(ids.completed).changes, 1); }
      finally { db.close(); }
    }
  } });
  try {
    const first = await executor.readSchedules(), second = await executor.readSchedules();
    assert.deepEqual(first.schedules, second.schedules);
    assert.equal(first.rulesVersion, 'schedules-1'); assert.equal(first.coverage.complete, true);
    assert.equal(first.schedules.length, 7);
    const find = key => first.schedules.find(row => row.id === ids[key]);
    assert.equal(find('deleted'), undefined); assert.equal(find('completed').completed, true);
    assert.equal(find('fixed').postsTransaction, true);
    assert.equal(find('fixed').amountCents, -10000);
    assert.equal(find('week').amountCents, null); assert.deepEqual(find('week').amountRange, { minCents: -15000, maxCents: -5000 });
    for (const key of ['month', 'week', 'year', 'last', 'omitted']) assert.deepEqual(find(key).date, cases[key].date);
    assert.equal(find('omitted').name, null); assert.equal(find('omitted').payeeId, null); assert.equal(find('omitted').accountId, null); assert.equal(find('omitted').amountCents, 0);
    for (const row of first.schedules) { assert.match(row.fingerprint, /^[a-f0-9]{64}$/); assert.equal(row.paid, undefined); assert.equal(row.status, undefined); }
    const snapshot = await executor.snapshot({ start: '2026-09-15', end: '2026-09-15' });
    assert.equal(snapshot.transactionMetadataVersion, '1');
    const linked = snapshot.transactions.find(row => row.scheduleId === ids.fixed), opening = snapshot.transactions.find(row => row.startingBalance);
    assert.ok(linked); assert.equal(linked.reconciled, true); assert.equal(linked.cleared, true); assert.ok(opening);
    for (const row of snapshot.transactions) {
      const inspected = await executor.inspectTransaction(row.id);
      assert.equal(transactionFingerprint(inspected.context, row), inspected.fingerprint);
    }
    assert.equal((await executor.inspectTransaction(opening.id)).eligibility.reason, 'starting_balance');
    assert.equal(snapshot.transactions.filter(row => row.scheduleId).length, 1, 'linking a transaction does not create another payment');
    await executor.close();
    parentPort.postMessage({ ok: true, networkAttempts, schedules: first.schedules.length, uncommonRulesPreserved: true, completedIncluded: true, deletedExcluded: true, metadataFingerprintsMatch: true, openingExcluded: true, noPaidInference: true });
  } catch (error) {
    try { await executor.close(); } catch {}
    parentPort.postMessage({ ok: false, error: error.code ?? error.message, networkAttempts });
  }
}
