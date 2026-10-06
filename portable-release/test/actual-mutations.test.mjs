import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ActualExecutor } from '../src/actual/executor.mjs';
import { ActualClient } from '../src/actual/client.mjs';
import { transactionFingerprint, TRANSACTION_FIELDS } from '../src/actual/transaction.mjs';
import { readEncryptedBackup } from '../src/backups/encrypted.mjs';
import { tempDirectory } from './helpers.mjs';

function fixture(t, changes = {}) {
  const dataDir = tempDirectory(t);
  const config = { dataDir, householdId: 'synthetic', dryRun: false, backup: { keyRef: 'backup-key' }, actual: { budgetId: 'budget', passwordRef: 'actual-password' } };
  let row = { id: 'transaction', account: 'account', date: '2026-09-14', amount: -250, payee: 'payee', notes: 'synthetic note', category: null, cleared: 1, reconciled: 0, ...changes.row };
  let pending, readsAfterPatch = 0, syncs = 0;
  const calls = [], references = [], queries = [];
  const account = { id: 'account', name: 'Synthetic account', offbudget: false, closed: false, ...changes.account };
  const categories = changes.categories ?? [{ id: 'category', group_id: 'group', name: 'Synthetic category', hidden: false }];
  const api = {
    init: async () => {}, downloadBudget: async () => {}, shutdown: async () => {},
    sync: async () => {
      if (++syncs === changes.failSyncAt) throw new Error('secret connection');
      if (syncs === 3) {
        if (changes.concurrentRow) row = { ...row, ...changes.concurrentRow };
        if (changes.concurrentCategory) Object.assign(categories[0], changes.concurrentCategory);
        if (changes.concurrentAccount) Object.assign(account, changes.concurrentAccount);
      }
    },
    q(table) {
      const query = { table, filter(value) { this.where = value; return this; }, select(value) { this.fields = value; return this; }, options(value) { this.optionsValue = value; return this; } };
      return query;
    },
    aqlQuery: async query => {
      queries.push(query);
      if (pending !== undefined && ++readsAfterPatch > (changes.staleReads ?? 0)) { row = { ...row, category: pending, ...changes.afterPatch }; pending = undefined; }
      return { data: changes.missing ? [] : [structuredClone(row)] };
    },
    getAccounts: async () => [account], getCategories: async () => categories,
    getCategoryGroups: async () => [{ id: 'group', name: 'Synthetic group', hidden: changes.hiddenGroup ?? false }],
    getPayees: async () => [{ id: 'payee', name: 'Synthetic payee', transfer_acct: changes.transferAccount ?? null }],
    exportBudget: async () => { if (changes.exportFailure) throw new Error('private export'); return Buffer.from('504b0304abcd', 'hex'); },
    updateTransaction: async (id, fields) => {
      pending = fields.category;
      if (changes.updateThrows) throw new Error('private unknown effect');
    }
  };
  for (const method of Object.keys(api).filter(key => key !== 'q')) {
    const fn = api[method];
    api[method] = async (...args) => { calls.push({ method, args }); return fn(...args); };
  }
  const resolveSecret = async ref => { references.push(ref); if (ref === 'backup-key' && changes.backupFailure) throw new Error('private key'); return ref === 'backup-key' ? 'ab'.repeat(32) : 'synthetic'; };
  const executor = new ActualExecutor({ api, config, resolveSecret, readbackTimeoutMs: changes.staleReads === Infinity ? 20 : 1000, pollIntervalMs: 1 });
  t.after(() => executor.close());
  return { executor, config, calls, queries, references, resolveSecret, row, categories, setRow: value => { row = { ...row, ...value }; }, args: async () => {
    const inspection = await executor.inspectTransaction('transaction');
    return { operationId: 'operation', targetId: 'transaction', expectedFingerprint: inspection.fingerprint, categoryId: 'category', expectedCategory: { id: 'category', name: 'Synthetic category', groupId: 'group', isIncome: false, hidden: false }, context: inspection.context };
  } };
}

test('inspect reads exact ID with splits all, canonicalizes and never resolves backup credentials', async t => {
  const f = fixture(t);
  const result = await f.executor.inspectTransaction('transaction');
  assert.equal(result.eligibility.eligible, true);
  assert.equal(result.transaction.categoryId, null);
  assert.equal(result.payee.name, 'Synthetic payee');
  assert.equal(result.fingerprint, transactionFingerprint(result.context, result.transaction));
  assert.deepEqual(f.references, ['actual-password']);
  assert.deepEqual(f.queries[0].where, { id: 'transaction' });
  assert.deepEqual(f.queries[0].fields, [...TRANSACTION_FIELDS]);
  assert.deepEqual(f.queries[0].optionsValue, { splits: 'all' });
});

test('one category-only patch follows durable encrypted backup, delayed readback and explicit sync; null undo preserves all other fields', async t => {
  const f = fixture(t, { staleReads: 3 });
  const args = await f.args();
  const result = await f.executor.changeCategory(args);
  assert.equal(result.status, 'applied');
  assert.ok(result.verifiedAt);
  assert.deepEqual(result.after, { ...result.before, categoryId: 'category' });
  assert.deepEqual(f.calls.filter(c => c.method === 'updateTransaction').map(c => c.args), [['transaction', { category: 'category' }]]);
  const exported = await readEncryptedBackup(result.backupRef, { config: f.config, resolveSecret: f.resolveSecret });
  assert.equal(exported.toString('hex'), '504b0304abcd');
  const methods = f.calls.map(c => c.method), patch = methods.indexOf('updateTransaction');
  assert.ok(methods.indexOf('exportBudget') < patch);
  assert.equal(methods.filter(method => method === 'sync').length, 4, 'inspection, before export, after export, after patch');
  assert.ok(methods.slice(patch + 1).filter(method => method === 'aqlQuery').length >= 5);
  const undo = await f.executor.changeCategory({ ...args, operationId: 'undo', expectedFingerprint: result.afterFingerprint, categoryId: null, expectedCategory: null });
  assert.equal(undo.status, 'applied'); assert.deepEqual(undo.after, result.before);
});

test('fingerprint, context, missing target and invalid input stop before any update', async t => {
  const f = fixture(t), args = await f.args();
  f.setRow({ amount: -251 });
  assert.equal((await f.executor.changeCategory(args)).code, 'MUTATION_CONFLICT');
  assert.equal((await f.executor.changeCategory({ ...args, context: { ...args.context, budgetId: 'other' } })).code, 'MUTATION_CONFLICT');
  assert.equal((await f.executor.changeCategory({ ...args, amount: 0 })).code, 'INPUT_INVALID');
  const missing = fixture(t, { missing: true });
  const result = await missing.executor.changeCategory(args);
  assert.equal(result.status, 'failed_before'); assert.equal(result.code, 'MUTATION_TARGET_MISSING');
  assert.equal([...f.calls, ...missing.calls].some(call => call.method === 'updateTransaction'), false);
});

test('split parents and children, transfers, opening, closed and off-budget accounts never call SDK update', async t => {
  for (const changes of [{ row: { is_parent: true } }, { row: { is_child: true } }, { row: { parent_id: 'parent' } }, { row: { transfer_id: 'other-side' } }, { transferAccount: 'other-account' }, { row: { starting_balance_flag: true } }, { account: { closed: true } }, { account: { offbudget: true } }]) {
    const f = fixture(t, changes);
    const args = await f.args();
    assert.equal((await f.executor.changeCategory(args)).code, 'MUTATION_INELIGIBLE');
    assert.equal(f.calls.some(call => ['exportBudget', 'updateTransaction'].includes(call.method)), false);
  }
});

test('deleted, hidden and hidden-group destination categories fail before write', async t => {
  for (const changes of [{ categories: [] }, { categories: [{ id: 'category', group_id: 'group', name: 'Hidden', hidden: true }] }, { hiddenGroup: true }]) {
    const f = fixture(t, changes);
    const result = await f.executor.changeCategory(await f.args());
    assert.equal(result.status, 'failed_before'); assert.equal(result.code, 'MUTATION_CATEGORY_INVALID');
    assert.equal(f.calls.some(call => call.method === 'updateTransaction'), false);
  }
});

test('renamed or moved destination invalidates the approval; unknown category keys are refused', async t => {
  const f = fixture(t), args = await f.args();
  f.categories[0].name = 'Changed after approval';
  assert.equal((await f.executor.changeCategory(args)).code, 'MUTATION_CATEGORY_INVALID');
  assert.equal((await f.executor.changeCategory({ ...args, expectedCategory: { ...args.expectedCategory, amount: 1 } })).code, 'INPUT_INVALID');
  assert.equal(f.calls.some(call => call.method === 'updateTransaction'), false);
});

test('changes during backup are detected by the second synchronized precondition', async t => {
  for (const changes of [{ concurrentRow: { notes: 'Changed while exporting' } }, { concurrentCategory: { name: 'Renamed while exporting' } }, { concurrentAccount: { closed: true } }]) {
    const f = fixture(t, changes), args = await f.args();
    const result = await f.executor.changeCategory(args);
    assert.equal(result.status, 'failed_before');
    assert.ok(result.backupRef, 'export already persisted before second precondition');
    assert.equal(f.calls.filter(call => call.method === 'exportBudget').length, 1);
    assert.equal(f.calls.filter(call => call.method === 'updateTransaction').length, 0);
  }
});

test('two queued approvals for the same previous state cannot both write', async t => {
  const f = fixture(t), args = await f.args();
  const [first, second] = await Promise.all([
    f.executor.changeCategory(args),
    f.executor.changeCategory({ ...args, operationId: 'second-operation' })
  ]);
  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'failed_before'); assert.equal(second.code, 'MUTATION_CONFLICT');
  assert.equal(f.calls.filter(call => call.method === 'updateTransaction').length, 1);
});

test('sync before write, export and encryption failure prevent any patch', async t => {
  for (const changes of [{ failSyncAt: 2 }, { exportFailure: true }, { backupFailure: true }]) {
    const f = fixture(t, changes), args = await f.args();
    const result = await f.executor.changeCategory(args);
    assert.equal(result.status, 'failed_before');
    assert.equal(f.calls.some(call => call.method === 'updateTransaction'), false);
    assert.ok(['ACTUAL_SYNC_FAILED', 'BACKUP_FAILED'].includes(result.code));
  }
});

test('post-write sync failure, SDK failure, divergent readback and deadline are uncertain without a second update', async t => {
  for (const changes of [{ failSyncAt: 4 }, { updateThrows: true }, { afterPatch: { amount: -999 } }, { staleReads: Infinity }]) {
    const f = fixture(t, changes), args = await f.args();
    const result = await f.executor.changeCategory(args);
    assert.equal(result.status, 'uncertain'); assert.equal(result.code, 'MUTATION_UNCERTAIN');
    assert.equal(f.calls.filter(call => call.method === 'updateTransaction').length, 1);
    assert.ok(result.backupRef);
    const count = f.calls.length;
    assert.equal((await f.executor.changeCategory({ ...args, operationId: 'retry-must-not-run' })).code, 'ACTUAL_FAILED');
    await assert.rejects(f.executor.inspectTransaction('transaction'), { code: 'ACTUAL_FAILED' });
    assert.equal(f.calls.length, count, 'poisoned executor cannot begin another SDK operation');
  }
});

test('an uncertain SDK result retires its live worker before another request and preserves evidence', async t => {
  const f = fixture(t), args = await f.args();
  let finishTermination, startTermination;
  const stopping = new Promise(resolve => { startTermination = resolve; });
  const workers = [];
  class FakeWorker extends EventEmitter {
    stdout = { resume() {} }; stderr = { resume() {} };
    messages = [];
    postMessage(message) {
      this.messages.push(message);
      if (workers.length > 1) queueMicrotask(() => this.emit('message', { id: message.id, result: 'replacement-response' }));
    }
    async terminate() { if (workers[0] === this) { startTermination(); await new Promise(resolve => { finishTermination = resolve; }); } }
  }
  const client = new ActualClient({ ...f.config, actual: { ...f.config.actual, timeoutMs: 1000 } }, { createWorker() { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  let resolved = false;
  const first = client.changeCategory(args).then(value => { resolved = true; return value; });
  const next = client.inspectTransaction('transaction');
  await new Promise(resolve => setImmediate(resolve));
  const result = { status: 'uncertain', code: 'MUTATION_UNCERTAIN', before: { synthetic: true }, backupRef: { id: 'evidence' } };
  workers[0].emit('message', { id: workers[0].messages[0].id, result });
  await stopping;
  assert.equal(resolved, false); assert.equal(workers.length, 1); assert.equal(workers[0].messages.length, 1);
  // Simulate an SDK completion message arriving while termination is pending.
  workers[0].emit('message', { id: workers[0].messages[0].id, result: { status: 'applied' } });
  assert.equal(resolved, false);
  finishTermination(); assert.deepEqual(await first, result); assert.equal(await next, 'replacement-response');
  assert.equal(workers.length, 2); await client.close();
});

test('failed retirement after a domain uncertain result permanently prevents a replacement worker', async t => {
  const f = fixture(t), args = await f.args();
  let worker, created = 0;
  const client = new ActualClient({ ...f.config, actual: { ...f.config.actual, timeoutMs: 1000 } }, { createWorker() {
    created++; worker = new EventEmitter(); worker.stdout = { resume() {} }; worker.stderr = { resume() {} };
    worker.postMessage = message => { queueMicrotask(() => worker.emit('message', { id: message.id, result: { status: 'uncertain', code: 'MUTATION_UNCERTAIN', backupRef: { id: 'preserved' } } })); };
    worker.terminate = async () => { throw new Error('private failure'); };
    return worker;
  } });
  const result = await client.changeCategory(args);
  assert.equal(result.backupRef.id, 'preserved');
  await assert.rejects(client.inspectTransaction('transaction'), { code: 'ACTUAL_FAILED' });
  assert.equal(created, 1); await client.close();
});

test('dry run denies executor and client mutation without initialization or a backup key', async t => {
  const f = fixture(t), args = await f.args();
  f.config.dryRun = true; f.calls.length = 0;
  assert.deepEqual(await f.executor.changeCategory(args), { status: 'failed_before', code: 'MUTATION_DRY_RUN' });
  assert.equal(f.calls.length, 0);
  const client = new ActualClient({ ...f.config, backup: undefined }, { createWorker() { assert.fail('must not create worker'); } });
  assert.equal((await client.changeCategory(args)).code, 'MUTATION_DRY_RUN'); await client.close();
});

test('worker mutation timeout resolves uncertain only after termination and sends a closed domain operation', async t => {
  const f = fixture(t), args = await f.args();
  let finish, workerOptions;
  class FakeWorker extends EventEmitter {
    stdout = { resume() {} }; stderr = { resume() {} };
    postMessage(message) { this.message = message; }
    async terminate() { await new Promise(resolve => { finish = resolve; }); }
  }
  const worker = new FakeWorker();
  const client = new ActualClient({ ...f.config, actual: { ...f.config.actual, timeoutMs: 20 } }, { createWorker(url, options) { workerOptions = options; return worker; } });
  let settled = false;
  const result = client.changeCategory(args).then(value => { settled = true; return value; });
  while (!finish) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(settled, false);
  assert.equal(worker.message.operation, 'changeCategory');
  assert.equal(workerOptions.workerData.backup.keyRef, 'backup-key');
  assert.equal(workerOptions.workerData.backup.key, undefined);
  finish(); assert.deepEqual(await result, { status: 'uncertain', code: 'MUTATION_UNCERTAIN' }); await client.close();
});
