import { AppError } from '../errors.mjs';
import { boundedPeriod } from './periods.mjs';
import { add, subtract, cents, percentage } from './money.mjs';

export const DEFAULT_SCOPE = Object.freeze({ includeOffBudget: false, includeClosed: false });
export function validateScope(input = DEFAULT_SCOPE) {
  if (!input || Array.isArray(input) || Object.keys(input).some(key => !['includeOffBudget', 'includeClosed'].includes(key)) || typeof input.includeOffBudget !== 'boolean' || typeof input.includeClosed !== 'boolean') throw new AppError('INPUT_INVALID');
  return Object.freeze({ ...input });
}

export function analyzeSnapshot(snapshot, { period = snapshot.period, scope = DEFAULT_SCOPE, today } = {}) {
  scope = validateScope(scope);
  boundedPeriod(period, today);
  if (snapshot.coverage?.complete !== true || snapshot.coverage.failedAccountIds?.length !== 0) throw new AppError('SNAPSHOT_INVALID');
  if (snapshot.period?.start !== period.start || snapshot.period?.end !== period.end || snapshot.currency !== 'BRL' || snapshot.rulesVersion !== '1') throw new AppError('SNAPSHOT_INVALID');
  if (![snapshot.accounts, snapshot.categories, snapshot.payees, snapshot.transactions, snapshot.budgetMonths].every(Array.isArray)) throw new AppError('SNAPSHOT_INVALID');
  const selected = snapshot.accounts.filter(account => (scope.includeOffBudget || !account.offBudget) && (scope.includeClosed || !account.closed));
  const selectedIds = new Set(selected.map(account => account.id));
  const categories = new Map(snapshot.categories.map(category => [category.id, category]));
  const payees = new Map(snapshot.payees.map(payee => [payee.id, payee]));
  const groups = new Map(), uncategorized = [], included = [];
  const totals = { grossExpenses: 0, refunds: 0, netExpenses: 0, income: 0, incomeReversals: 0, netIncome: 0, unclassifiedInflows: 0, netMovement: 0 };
  const excluded = { parents: 0, transfers: 0, accounts: 0 };
  for (const transaction of snapshot.transactions) {
    cents(transaction.amount);
    if (transaction.date < period.start || transaction.date > period.end) throw new AppError('SNAPSHOT_INVALID');
    if (transaction.isParent) { excluded.parents++; continue; }
    if (transaction.transferId || payees.get(transaction.payeeId)?.transferAccountId) { excluded.transfers++; continue; }
    if (!selectedIds.has(transaction.accountId)) { excluded.accounts++; continue; }
    included.push(transaction);
    const category = categories.get(transaction.categoryId);
    const income = category?.isIncome === true;
    const expense = category != null && !income;
    if (transaction.categoryId == null) uncategorized.push(transaction);
    if (transaction.amount < 0) {
      const field = income ? 'incomeReversals' : 'grossExpenses';
      totals[field] = add(totals[field], -transaction.amount);
    } else if (transaction.amount > 0) {
      const field = income ? 'income' : expense ? 'refunds' : 'unclassifiedInflows';
      totals[field] = add(totals[field], transaction.amount);
    }
    totals.netMovement = add(totals.netMovement, transaction.amount);
    if (!income && (transaction.amount < 0 || expense)) {
      const key = category?.id ?? (transaction.categoryId ? `unknown:${transaction.categoryId}` : 'uncategorized');
      const group = groups.get(key) ?? { id: category?.id ?? transaction.categoryId, name: category?.name ?? (transaction.categoryId ? 'Categoria desconhecida' : 'Sem categoria'), gross: 0, refunds: 0, net: 0, count: 0 };
      group.count++;
      if (transaction.amount < 0) group.gross = add(group.gross, -transaction.amount);
      if (transaction.amount > 0 && expense) group.refunds = add(group.refunds, transaction.amount);
      group.net = subtract(group.gross, group.refunds);
      groups.set(key, group);
    }
  }
  totals.netExpenses = subtract(totals.grossExpenses, totals.refunds);
  totals.netIncome = subtract(totals.income, totals.incomeReversals);
  const byCategory = [...groups.values()].sort((a, b) => b.net - a.net || String(a.id).localeCompare(String(b.id)));
  const budgets = snapshot.budgetMonths.flatMap(month => month.categories.filter(category => !category.isIncome).map(category => {
    const spent = category.spent == null ? null : -cents(category.spent);
    const available = category.balance == null || category.spent == null ? null : subtract(category.balance, category.spent);
    const carried = available == null || category.budgeted == null ? null : subtract(available, category.budgeted);
    return { month: month.month, ...category, spent, available, carried, utilization: spent == null || available == null ? null : percentage(spent, available) };
  }));
  return {
    metadata: {
      snapshotId: snapshot.id, householdId: snapshot.householdId, budgetId: snapshot.budgetId,
      period: { ...period }, timezone: snapshot.timezone, currency: snapshot.currency, syncedAt: snapshot.syncedAt,
      rulesVersion: 'finance-1', snapshotRulesVersion: snapshot.rulesVersion, complete: true, scope, accountIds: selected.map(account => account.id),
      excludedAccountIds: snapshot.accounts.filter(account => !selectedIds.has(account.id)).map(account => account.id),
      currentDayPartial: period.end === today
    },
    totals, byCategory, budgets, excluded, accounts: snapshot.accounts,
    includedTransactions: included, uncategorized: uncategorized.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)),
    payees, categories, selectedAccounts: selected
  };
}
