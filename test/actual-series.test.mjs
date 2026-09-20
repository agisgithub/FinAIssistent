import test from 'node:test';
import assert from 'node:assert/strict';
import { q } from '@actual-app/api';
import { ActualExecutor } from '../src/actual/executor.mjs';
import { tempDirectory } from './helpers.mjs';

const period = { start: '2026-04-01', end: '2026-09-20' };
function fixture(t, categories) {
  const calls = [], config = { dataDir: tempDirectory(t), householdId: 'home', timezone: 'America/Sao_Paulo', currency: 'BRL', actual: { serverURL: 'http://actual.invalid', budgetId: 'budget', passwordRef: 'password' } };
  const api = {
    q,
    init: async () => calls.push({ method: 'init' }), downloadBudget: async () => calls.push({ method: 'downloadBudget' }),
    sync: async () => calls.push({ method: 'sync' }), shutdown: async () => calls.push({ method: 'shutdown' }),
    getCategories: async () => categories,
    getCategoryGroups: async () => [{ id: 'home', name: 'Casa' }, { id: 'leisure', name: 'Lazer' }],
    getAccounts: async () => [{ id: 'checking', closed: false, offbudget: false }],
    getPayees: async () => [{ id: 'shop', transfer_acct: null }],
    aqlQuery: async query => {
      calls.push({ method: 'aqlQuery', query: query.serialize() });
      return { data: [
        { id: 'april', date: '2026-04-10', amount: -1234, category: 'consumption', account: 'checking', payee: 'shop', transfer_id: null, is_parent: false },
        { id: 'may-refund', date: '2026-05-10', amount: 234, category: 'consumption', account: 'checking', payee: 'shop', transfer_id: null, is_parent: false }
      ] };
    }
  };
  const executor = new ActualExecutor({ api, config, resolveSecret: async () => 'secret' });
  t.after(() => executor.close().catch(() => {}));
  return { executor, calls };
}

test('Actual monthly series uses one public AQL transaction query for the whole period with inline splits', async t => {
  const f = fixture(t, [{ id: 'consumption', name: 'Consumo', group_id: 'home', is_income: false, hidden: false }]);
  const result = await f.executor.monthlySpendingSeries({ period, categoryName: 'Consumo', scope: { includeClosed: false, includeOffBudget: false } });
  const queries = f.calls.filter(call => call.method === 'aqlQuery');
  assert.equal(queries.length, 1);
  assert.equal(queries[0].query.table, 'transactions');
  assert.deepEqual(queries[0].query.tableOptions, { splits: 'inline' });
  assert.deepEqual(queries[0].query.filterExpressions, [{ date: { $gte: period.start, $lte: period.end }, category: 'consumption' }]);
  assert.deepEqual(result.months.map(row => row.netCents), [1234,-234,0,0,0,0]);
  assert.equal(result.totals.netCents, 1000);
});

test('homonymous category stops before AQL and returns only human-readable choices', async t => {
  const f = fixture(t, [
    { id: 'consumption', name: 'Consumo', group_id: 'home', is_income: false, hidden: false },
    { id: 'consumption-leisure', name: 'Consumo', group_id: 'leisure', is_income: false, hidden: false }
  ]);
  const result = await f.executor.monthlySpendingSeries({ period, categoryName: 'Consumo', scope: { includeClosed: false, includeOffBudget: false } });
  assert.equal(result.status, 'choice_required'); assert.equal(result.reason, 'ambiguous');
  assert.deepEqual(result.options, [{ name: 'Consumo', groupName: 'Casa', hidden: false }, { name: 'Consumo', groupName: 'Lazer', hidden: false }]);
  assert.equal(JSON.stringify(result).includes('consumption-leisure'), false);
  assert.equal(f.calls.some(call => call.method === 'aqlQuery'), false);
});
