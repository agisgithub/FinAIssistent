import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSnapshot } from '../src/finance/analyze.mjs';
import { formatMoney, sum, percentage } from '../src/finance/money.mjs';
import { financialSnapshot, TODAY, PERIOD } from './fixtures/financial.mjs';

test('financial fixture reconciles splits, card purchases/payments, refunds, income reversals and ambiguous inflows', () => {
  const result = analyzeSnapshot(financialSnapshot(), { today: TODAY });
  assert.deepEqual(result.totals, { grossExpenses: 34000, refunds: 2000, netExpenses: 32000, income: 100000, incomeReversals: 1000, netIncome: 99000, unclassifiedInflows: 5000, netMovement: 72000 });
  assert.equal(result.totals.netMovement, result.totals.netIncome + result.totals.unclassifiedInflows - result.totals.netExpenses);
  assert.deepEqual(result.uncategorized.map(row => row.id).sort(), ['uncategorized', 'unknown-inflow']);
  assert.deepEqual(result.excluded, { parents: 1, transfers: 3, accounts: 2 });
  assert.deepEqual(result.metadata.accountIds, ['checking', 'card']);
  assert.equal(result.byCategory.find(row => row.id === 'food').net, 27000);
});
test('scope separates closed and off-budget accounts without changing the Actual monthly envelope', () => {
  const snapshot = financialSnapshot();
  const regular = analyzeSnapshot(snapshot, { today: TODAY });
  const all = analyzeSnapshot(snapshot, { today: TODAY, scope: { includeClosed: true, includeOffBudget: true } });
  assert.equal(all.totals.grossExpenses, 154000);
  assert.deepEqual(all.budgets, regular.budgets);
  assert.deepEqual(all.metadata.excludedAccountIds, []);
});
test('budget values preserve missing/zero limits and derive availability from signed Actual spent', () => {
  const result = analyzeSnapshot(financialSnapshot(), { today: TODAY });
  const [food, zero, missing] = result.budgets;
  assert.equal(food.available, 35000); assert.equal(food.carried, 5000); assert.equal(food.spent, 27000);
  assert.equal(food.carryover, true); assert.equal(food.utilization, '77,1%');
  assert.equal(zero.available, 0); assert.equal(zero.utilization, null);
  assert.equal(missing.available, null); assert.equal(missing.carried, null); assert.equal(missing.spent, null);
});
test('complete period coverage and safe integer cents are required before aggregation', () => {
  for (const mutate of [
    data => { data.coverage.complete = false; },
    data => { data.coverage.failedAccountIds = ['checking']; },
    data => { data.period.end = '2026-09-14'; },
    data => { data.currency = 'USD'; },
    data => { data.rulesVersion = 'unknown'; },
    data => { data.transactions[0].amount = 1.2; },
    data => { data.transactions[0].date = '2026-08-31'; },
    data => { data.transactions[0].amount = -Number.MAX_SAFE_INTEGER; }
  ]) { const snapshot = financialSnapshot(); mutate(snapshot); assert.throws(() => analyzeSnapshot(snapshot, { period: PERIOD, today: TODAY }), { code: 'SNAPSHOT_INVALID' }); }
  assert.throws(() => sum([Number.MAX_SAFE_INTEGER, 1]), { code: 'SNAPSHOT_INVALID' });
});
test('money formatting preserves the last cent at positive and negative integer limits', () => {
  assert.equal(formatMoney(Number.MAX_SAFE_INTEGER), 'R$ 90.071.992.547.409,91');
  assert.equal(formatMoney(-Number.MAX_SAFE_INTEGER), '-R$ 90.071.992.547.409,91');
  assert.equal(formatMoney(1), 'R$ 0,01'); assert.equal(formatMoney(-1), '-R$ 0,01');
  assert.equal(percentage(100, 0), null); assert.equal(percentage(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), '100,0%');
});
