import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ActualExecutor } from '../src/actual/executor.mjs';

const period = { start: '2026-09-01', end: '2026-09-30' };
async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'finai-actual-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = { dataDir, householdId: 'test', timezone: 'America/Sao_Paulo', currency: 'BRL', actual: { serverURL: 'http://actual.invalid', budgetId: 'test-budget', passwordRef: 'password', encryptionPasswordRef: 'encryption' } };
  const calls = [], secrets = [];
  let active = 0, maxActive = 0;
  const responses = {
    init: undefined, downloadBudget: undefined, sync: undefined, shutdown: undefined,
    getAccounts: [{ id: 'account-a', name: 'Synthetic account' }],
    getCategories: [{ id: 'category', name: 'Synthetic category', group_id: 'group' }],
    getCategoryGroups: [{ id: 'group', name: 'Synthetic group' }],
    getPayees: [], getBudgetMonths: ['2026-08', '2026-09', '2026-10'],
    getSchedules: [{ id: 'schedule', rule: 'rule', next_date: '2026-09-30', completed: false, posts_transaction: false, amount: -100, amountOp: 'is', date: '2026-09-30' }],
    getBudgetMonth: { month: '2026-09', totalBudgeted: 10000, totalSpent: -100, totalBalance: 9900, categoryGroups: [] },
    getAccountBalance: 4900,
    getTransactions: [{ id: 'transaction', account: 'account-a', date: '2026-09-15', amount: -100, category: 'category' }]
  };
  const api = Object.fromEntries(Object.entries(responses).map(([method, result]) => [method, async (...args) => {
    active++; maxActive = Math.max(maxActive, active); calls.push({ method, args });
    try { await new Promise(resolve => setImmediate(resolve)); return method in overrides ? await overrides[method](...args) : structuredClone(result); }
    finally { active--; }
  }]));
  const executor = new ActualExecutor({ api, config, resolveSecret: async reference => { secrets.push(reference); return `synthetic-${reference}`; } });
  t.after(() => executor.close().catch(() => {}));
  return { executor, config, calls, secrets, api, get maxActive() { return maxActive; } };
}

test('exclusive SDK lifecycle resolves secrets locally, explicitly syncs each snapshot and uses historical cutoff', async t => {
  const f = await fixture(t);
  const first = f.executor.snapshot(period), second = f.executor.snapshot(period), closing = f.executor.close();
  const [a, b] = await Promise.all([first, second]);
  await closing;
  assert.notEqual(a.id, b.id);
  assert.equal(a.accounts[0].balance, 4900);
  assert.equal(a.coverage.complete, true);
  assert.equal(f.maxActive, 1);
  assert.deepEqual(f.calls.slice(0, 3).map(call => call.method), ['init', 'downloadBudget', 'sync']);
  assert.equal(f.calls.filter(call => call.method === 'init').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'downloadBudget').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'sync').length, 2);
  assert.equal(f.calls.filter(call => call.method === 'shutdown').length, 1);
  assert.equal(f.calls.at(-1).method, 'shutdown');
  assert.deepEqual(f.secrets, ['password', 'encryption']);
  assert.equal(f.config.actual.password, undefined);
  assert.equal(f.calls[0].args[0].password, 'synthetic-password');
  assert.deepEqual(f.calls[1].args, ['test-budget', { password: 'synthetic-encryption' }]);
  for (const call of f.calls.filter(call => call.method === 'getAccountBalance')) {
    const cutoff = call.args[1];
    assert.equal(cutoff.getFullYear(), 2026); assert.equal(cutoff.getMonth(), 8); assert.equal(cutoff.getDate(), 30);
  }
  assert.deepEqual(f.calls.filter(call => call.method === 'getBudgetMonth').map(call => call.args[0]), ['2026-09', '2026-09']);
  await assert.rejects(f.executor.snapshot(period), { code: 'SHUTTING_DOWN' });
});

test('explicit sync failure stops all reads and never becomes a successful snapshot', async t => {
  const f = await fixture(t, { sync: async () => { throw new Error('server URL and secret'); } });
  await assert.rejects(f.executor.snapshot(period), { code: 'ACTUAL_SYNC_FAILED', message: 'ACTUAL_SYNC_FAILED' });
  assert.deepEqual(f.calls.map(call => call.method), ['init', 'downloadBudget', 'sync']);
});

test('failed account read marks incomplete coverage instead of inventing a zero balance', async t => {
  const f = await fixture(t, { getTransactions: async () => { throw new Error('private transaction'); } });
  const snapshot = await f.executor.snapshot(period);
  assert.deepEqual(snapshot.coverage, { complete: false, failedAccountIds: ['account-a'] });
  assert.equal(snapshot.accounts[0].balance, null);
  assert.deepEqual(snapshot.transactions, []);
});

test('failed initialization cleans up before retry, and cleanup failure disables the SDK', async t => {
  let attempts = 0;
  const f = await fixture(t, { init: async () => { if (++attempts === 1) throw new Error('password leaked by SDK'); } });
  await assert.rejects(f.executor.snapshot(period), { code: 'ACTUAL_FAILED' });
  assert.deepEqual(f.calls.map(call => call.method), ['init', 'shutdown']);
  await f.executor.snapshot(period);
  assert.equal(attempts, 2);
  const broken = await fixture(t, { init: async () => { throw new Error('init'); }, shutdown: async () => { throw new Error('shutdown'); } });
  await assert.rejects(broken.executor.snapshot(period), { code: 'ACTUAL_FAILED' });
  await assert.rejects(broken.executor.snapshot(period), { code: 'ACTUAL_FAILED' });
  assert.deepEqual(broken.calls.map(call => call.method), ['init', 'shutdown']);
});

test('wrong budget month and malformed SDK lists fail with sanitized codes', async t => {
  const f = await fixture(t, { getBudgetMonth: async () => ({ month: '2026-08' }) });
  await assert.rejects(f.executor.snapshot(period), { code: 'SNAPSHOT_INVALID' });
  const malformed = await fixture(t, { getAccounts: async () => ({ data: [] }) });
  await assert.rejects(malformed.executor.snapshot(period), { code: 'SNAPSHOT_INVALID' });
});

test('schedule catalog uses the same serialized lifecycle and explicit sync without backup credentials', async t => {
  const f = await fixture(t);
  const [first, snapshot, second] = await Promise.all([f.executor.readSchedules(), f.executor.snapshot(period), f.executor.readSchedules()]);
  assert.equal(first.schedules[0].fingerprint, second.schedules[0].fingerprint);
  assert.equal(snapshot.coverage.complete, true);
  assert.equal(f.maxActive, 1);
  assert.deepEqual(f.calls.slice(0, 4).map(call => call.method), ['init', 'downloadBudget', 'sync', 'getSchedules']);
  assert.equal(f.calls.filter(call => call.method === 'sync').length, 3);
  assert.equal(f.calls.filter(call => call.method === 'getSchedules').length, 2);
  assert.deepEqual(f.secrets, ['password', 'encryption']);
  await f.executor.close();
  await assert.rejects(f.executor.readSchedules(), { code: 'SHUTTING_DOWN' });
});

test('schedule sync and malformed catalog errors stop without leaking SDK text or returning partial success', async t => {
  const sync = await fixture(t, { sync: async () => { throw new Error('private server URL'); } });
  await assert.rejects(sync.executor.readSchedules(), { code: 'ACTUAL_SYNC_FAILED', message: 'ACTUAL_SYNC_FAILED' });
  assert.equal(sync.calls.some(call => call.method === 'getSchedules'), false);
  const malformed = await fixture(t, { getSchedules: async () => [{ id: 'missing-other-fields' }] });
  await assert.rejects(malformed.executor.readSchedules(), { code: 'SNAPSHOT_INVALID' });
  const failed = await fixture(t, { getSchedules: async () => { throw new Error('private schedule name'); } });
  await assert.rejects(failed.executor.readSchedules(), { code: 'ACTUAL_FAILED', message: 'ACTUAL_FAILED' });
});
