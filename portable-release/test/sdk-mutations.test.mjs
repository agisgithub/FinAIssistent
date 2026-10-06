import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { tempDirectory } from './helpers.mjs';

if (isMainThread) {
  test('pinned SDK simple category/null writes preserve all other fields; encrypted export restores and split regression is blocked', { timeout: 120000 }, async t => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { dataDir: tempDirectory(t) }, stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume();
    try {
      const result = await new Promise((resolve, reject) => {
        worker.once('message', resolve); worker.once('error', reject);
        worker.once('exit', code => { if (code !== 0) reject(new Error('Synthetic mutation worker failed')); });
      });
      assert.deepEqual(result, { ok: true, networkAttempts: 0, categoryOnly: true, nullRestored: true, otherFieldsUnchanged: true, encryptedExportRestored: true, splitUpdatesBlocked: 2, reproducedSdkSplitDefect: true });
    } finally { await worker.terminate(); }
  });
} else {
  process.stdout.write = () => true; process.stderr.write = () => true;
  const { default: http } = await import('node:http'), { default: https } = await import('node:https'), { default: net } = await import('node:net');
  const { syncBuiltinESMExports } = await import('node:module');
  let networkAttempts = 0;
  const deny = () => { networkAttempts++; throw new Error('SYNTHETIC_NETWORK_BLOCKED'); };
  http.request = deny; http.get = deny; https.request = deny; https.get = deny;
  net.connect = deny; net.createConnection = deny; globalThis.fetch = deny; syncBuiltinESMExports();
  const { loadPinnedActual } = await import('../src/actual/sdk-loader.mjs');
  const api = await loadPinnedActual();
  const { ActualExecutor } = await import('../src/actual/executor.mjs');
  const { readEncryptedBackup } = await import('../src/backups/encrypted.mjs');
  let account, category, simple, parent, child, updates = 0;
  const config = { dataDir: workerData.dataDir, householdId: 'synthetic', dryRun: false, backup: { keyRef: 'synthetic-key' }, actual: { budgetId: 'synthetic-budget', passwordRef: 'synthetic-password' } };
  const resolveSecret = async ref => ref === 'synthetic-key' ? '91'.repeat(32) : 'synthetic-never-sent';
  const executor = new ActualExecutor({ config, resolveSecret, api: {
    ...api,
    init: ({ dataDir }) => api.init({ dataDir, verbose: false }), sync: async () => {},
    // Offline fixture: no server credentials or remote sync; every financial
    // read/write/export/import below exercises the actual pinned SDK.
    downloadBudget: async () => {
      await api.runImport('Synthetic mutation contract', async () => {});
      account = await api.createAccount({ name: 'Synthetic account' });
      const group = await api.createCategoryGroup({ name: 'Synthetic group' });
      category = await api.createCategory({ name: 'Synthetic destination', group_id: group });
      const old = await api.createCategory({ name: 'Synthetic original', group_id: group });
      const payee = await api.createPayee({ name: 'Synthetic child payee' });
      const imported = await api.importTransactions(account, [
        { date: '2026-09-14', amount: -250, notes: 'synthetic standalone', imported_id: 'synthetic-simple', payee_name: 'Synthetic merchant' },
        { date: '2026-09-15', amount: -300, notes: 'synthetic parent', imported_id: 'synthetic-split', subtransactions: [
          { amount: -100, category: old, payee, notes: 'synthetic child' }, { amount: -200, category: old }
        ] }
      ]);
      assert.equal(imported.errors.length, 0);
      const rows = await api.getTransactions(account, '2026-09-01', '2026-09-30');
      simple = rows.find(row => row.notes === 'synthetic standalone'); parent = rows.find(row => row.is_parent); child = parent.subtransactions[0];
    },
    updateTransaction: async (...args) => { updates++; return api.updateTransaction(...args); }
  } });
  const full = async id => (await api.aqlQuery(api.q('transactions').filter({ id }).select('*').options({ splits: 'all' }))).data[0];
  const withoutCategory = row => { const { category, ...rest } = row; return rest; };
  try {
    // Lazy executor initializes fixture before simple ID becomes available.
    await executor.runExclusive(async () => {});
    const inspection = await executor.inspectTransaction(simple.id), initial = await full(simple.id), originalChild = await full(child.id);
    const input = { operationId: 'synthetic-categorize', targetId: simple.id, context: inspection.context, expectedFingerprint: inspection.fingerprint, categoryId: category, expectedCategory: inspection.categories.find(row => row.id === category) };
    const changed = await executor.changeCategory(input);
    assert.equal(changed.status, 'applied');
    const categorized = await full(simple.id);
    assert.equal(categorized.category, category); assert.deepEqual(withoutCategory(categorized), withoutCategory(initial));
    const undone = await executor.changeCategory({ ...input, operationId: 'synthetic-undo', categoryId: null, expectedCategory: null, expectedFingerprint: changed.afterFingerprint });
    assert.equal(undone.status, 'applied');
    const restored = await full(simple.id);
    assert.equal(restored.category, null); assert.deepEqual(withoutCategory(restored), withoutCategory(initial));
    for (const targetId of [parent.id, child.id]) {
      const read = await executor.inspectTransaction(targetId), count = updates;
      const result = await executor.changeCategory({ ...input, operationId: 'blocked-' + targetId, targetId, expectedFingerprint: read.fingerprint });
      assert.equal(result.status, 'failed_before'); assert.equal(result.code, 'MUTATION_INELIGIBLE'); assert.equal(updates, count);
    }
    // Deliberately bypass our guard ONLY in this disposable SDK regression.
    // SDK 26.9.0 replaces a child with the partial patch and defaults amount to
    // zero/payee to its parent's payee. A future SDK upgrade must revisit this.
    await api.updateTransaction(child.id, { category });
    let corrupt;
    for (let attempt = 0; attempt < 100; attempt++) {
      corrupt = await full(child.id); if (corrupt.category === category) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(corrupt.amount, 0); assert.equal(corrupt.payee, null); assert.equal(originalChild.amount, -100); assert.ok(originalChild.payee);
    const zip = await readEncryptedBackup(changed.backupRef, { config, resolveSecret });
    assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304');
    await api.importBudget(zip, { type: 'actual' }); zip.fill(0);
    assert.deepEqual(await full(simple.id), initial); assert.deepEqual(await full(child.id), originalChild);
    await executor.close();
    parentPort.postMessage({ ok: true, networkAttempts, categoryOnly: true, nullRestored: true, otherFieldsUnchanged: true, encryptedExportRestored: true, splitUpdatesBlocked: 2, reproducedSdkSplitDefect: true });
  } catch (error) {
    try { await executor.close(); } catch {}
    parentPort.postMessage({ ok: false, code: error.code ?? error.name, networkAttempts });
  }
}
