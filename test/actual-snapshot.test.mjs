import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot, validatePeriod } from '../src/actual/snapshot.mjs';

function input() {
  return {
    config: { householdId: 'test', timezone: 'America/Sao_Paulo', currency: 'BRL', actual: { budgetId: 'synthetic-budget' } },
    period: { start: '2026-09-01', end: '2026-09-30' }, syncedAt: '2026-09-15T12:00:00Z',
    accounts: [{ id: 'account', name: 'Synthetic account', balance: 9700 }],
    categories: [{ id: 'category', name: 'Synthetic category', group_id: 'group' }], payees: [],
    transactions: [{ id: 'parent', account: 'account', date: '2026-09-15', amount: -300, is_parent: true, subtransactions: [
      { id: 'child-a', amount: -100, category: 'category' }, { id: 'child-b', amount: -200, category: 'category' }
    ] }],
    budgetMonths: [{ month: '2026-09', totalBudgeted: 500, totalSpent: -300, totalBalance: 200, rawSecret: 'not propagated', categoryGroups: [
      { id: 'group', categories: [{ id: 'category', name: 'Synthetic category', budgeted: 500, spent: -300, balance: 200, carryover: true }] },
      { id: 'income-group', is_income: true, categories: [{ id: 'income', name: 'Income', is_income: true, received: 10000 }] }
    ] }]
  };
}

test('normalization flattens grouped splits exactly once and retains marked parents for audit', () => {
  const snapshot = normalizeSnapshot(input());
  assert.equal(snapshot.transactions.length, 3);
  assert.equal(snapshot.transactions[0].isParent, true);
  assert.equal(snapshot.transactions[1].isChild, true);
  assert.equal(snapshot.transactions[1].parentId, 'parent');
  assert.equal(snapshot.transactions.filter(row => !row.isParent).reduce((sum, row) => sum + row.amount, 0), -300);
  assert.equal(snapshot.transactions[0].subtransactions, undefined);
  assert.equal(snapshot.rulesVersion, '1');
  assert.deepEqual(snapshot.coverage, { complete: true, failedAccountIds: [] });
  assert.equal(snapshot.accounts[0].balance, 9700);
  assert.deepEqual(snapshot.budgetMonths[0].categories[1], {
    id: 'income', name: 'Income', groupId: 'income-group', isIncome: true,
    budgeted: null, spent: null, received: 10000, balance: null, carryover: null
  });
  assert.equal(snapshot.budgetMonths[0].rawSecret, undefined);
  assert.equal(snapshot.budgetMonths[0].categories[0].carryover, true);
});

test('malformed coverage, splits, duplicates and non-integer money are rejected', () => {
  const mutations = [
    data => { data.accounts[0].balance = null; },
    data => { data.accounts[0].offbudget = 'false'; },
    data => { data.transactions[0].amount = -299; },
    data => { data.transactions[0].subtransactions[0].amount = -100.5; },
    data => { data.transactions[0].subtransactions[0].parent_id = 'wrong-parent'; },
    data => { data.transactions[0].subtransactions[0].account = 'other-account'; },
    data => { data.transactions.push(data.transactions[0].subtransactions[0]); },
    data => { data.transactions[0].subtransactions = []; },
    data => { data.transactions = [{ id: 'orphan', account: 'account', date: '2026-09-15', amount: -10, is_child: true }]; },
    data => { data.categories.push(data.categories[0]); },
    data => { data.budgetMonths[0].totalBalance = Number.MAX_SAFE_INTEGER + 1; },
    data => { data.budgetMonths[0].categoryGroups[0].categories[0].carryover = 'false'; },
    data => { data.budgetMonths[0].month = '2026-10'; },
    data => { data.syncedAt = 'not a date'; }
  ];
  for (const mutate of mutations) {
    const data = input(); mutate(data);
    assert.throws(() => normalizeSnapshot(data), { code: 'SNAPSHOT_INVALID' });
  }
});

test('safe-integer overflow in split totals is rejected even if each row is individually valid', () => {
  const data = input();
  data.transactions[0].amount = Number.MAX_SAFE_INTEGER;
  data.transactions[0].subtransactions[0].amount = Number.MAX_SAFE_INTEGER;
  data.transactions[0].subtransactions[1].amount = 1;
  assert.throws(() => normalizeSnapshot(data), { code: 'SNAPSHOT_INVALID' });
});

test('periods are inclusive, valid calendar dates, and limited to 24 months', () => {
  validatePeriod({ start: '2024-01-01', end: '2026-01-01' });
  validatePeriod({ start: '2024-02-29', end: '2024-02-29' });
  for (const period of [
    { start: '2024-01-01', end: '2026-01-02' },
    { start: '2026-02-29', end: '2026-03-01' },
    { start: '2026-09-30', end: '2026-09-01' },
    { start: '2026-09-01T00:00:00Z', end: '2026-09-30' }
  ]) assert.throws(() => validatePeriod(period), { code: 'INPUT_INVALID' });
});
