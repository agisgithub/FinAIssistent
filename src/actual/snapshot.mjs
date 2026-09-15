import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.mjs';

const invalid = () => { throw new AppError('SNAPSHOT_INVALID'); };
const money = value => Number.isSafeInteger(value) ? value : invalid();
const text = (value, max = 10000) => typeof value === 'string' && value.length <= max ? value : invalid();
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : invalid();
const nullableId = value => value == null || value === '' ? null : id(value);
const flag = value => value == null || value === false || value === 0 ? false : value === true || value === 1 ? true : invalid();
const optionalMoney = value => value == null ? null : money(value);
const unique = rows => { if (new Set(rows.map(row => row.id)).size !== rows.length) invalid(); return rows; };
export const validMonth = value => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
export function validatePeriod(period) {
  if (!period || Array.isArray(period) || Object.keys(period).some(key => !['start', 'end'].includes(key)) || !validDate(period.start) || !validDate(period.end) || period.start > period.end) throw new AppError('INPUT_INVALID');
  const limit = new Date(period.start + 'T00:00:00Z');
  limit.setUTCMonth(limit.getUTCMonth() + 24);
  if (Date.parse(period.end) > limit.getTime()) throw new AppError('INPUT_INVALID');
}

function normalizeBudgetMonths(months, period) {
  const seen = new Set();
  return months.map(month => {
    if (!month || !validMonth(month.month) || month.month < period.start.slice(0, 7) || month.month > period.end.slice(0, 7) || seen.has(month.month) || !Array.isArray(month.categoryGroups)) invalid();
    seen.add(month.month);
    const categories = month.categoryGroups.flatMap(group => {
      if (!group || !Array.isArray(group.categories)) invalid();
      return group.categories.map(category => ({
        id: id(category.id), name: text(category.name, 500),
        groupId: nullableId(category.group_id ?? group.id), isIncome: flag(category.is_income ?? group.is_income),
        budgeted: optionalMoney(category.budgeted), spent: optionalMoney(category.spent),
        received: optionalMoney(category.received), balance: optionalMoney(category.balance),
        carryover: category.carryover == null ? null : flag(category.carryover)
      }));
    });
    return {
      month: month.month, totalBudgeted: optionalMoney(month.totalBudgeted),
      totalSpent: optionalMoney(month.totalSpent), totalBalance: optionalMoney(month.totalBalance),
      categories: unique(categories)
    };
  });
}

export function normalizeSnapshot({ config, period, accounts, categories, categoryGroups = [], payees, transactions, budgetMonths = [], syncedAt, failedAccountIds = [] }) {
  validatePeriod(period);
  if (![accounts, categories, categoryGroups, payees, transactions, budgetMonths, failedAccountIds].every(Array.isArray) || !Number.isFinite(Date.parse(syncedAt))) invalid();
  const normalizedAccounts = accounts.map(a => ({ id: id(a.id), name: text(a.name, 500), offBudget: flag(a.offbudget), closed: flag(a.closed), balance: a.balance == null ? null : money(a.balance) }));
  const accountIds = new Set(normalizedAccounts.map(a => a.id));
  if (accountIds.size !== accounts.length) invalid();
  const failed = new Set(failedAccountIds);
  if (failed.size !== failedAccountIds.length || failedAccountIds.some(account => !accountIds.has(account)) || normalizedAccounts.some(account => account.balance === null && !failed.has(account.id))) invalid();
  const rows = [], seen = new Set();
  const visit = (row, parent = null) => {
    if (!row || rows.length >= 1000000) invalid();
    const rowId = id(row.id);
    if (seen.has(rowId)) invalid();
    seen.add(rowId);
    const accountId = nullableId(row.account ?? parent?.account);
    const date = row.date ?? parent?.date;
    if (!accountIds.has(accountId) || !validDate(date) || date < period.start || date > period.end) invalid();
    const children = row.subtransactions ?? [];
    if (!Array.isArray(children) || (parent && children.length)) invalid();
    const parentId = nullableId(row.parent_id ?? parent?.id);
    const isParent = flag(row.is_parent) || children.length > 0;
    const isChild = flag(row.is_child) || parent !== null || parentId !== null;
    if (isParent && isChild) invalid();
    if (parent && (parentId !== parent.id || accountId !== parent.account || date !== parent.date)) invalid();
    rows.push({
      id: rowId, accountId, date, amount: money(row.amount),
      payeeId: nullableId(row.payee ?? parent?.payee), notes: text(row.notes ?? ''),
      categoryId: nullableId(row.category), parentId, isParent, isChild,
      transferId: nullableId(row.transfer_id), cleared: flag(row.cleared)
    });
    for (const child of children) visit(child, row);
  };
  for (const row of transactions) visit(row);
  const byId = new Map(rows.map(row => [row.id, row]));
  const totals = new Map();
  for (const row of rows) {
    if (!row.isChild) continue;
    const parent = byId.get(row.parentId);
    if (!parent?.isParent || parent.accountId !== row.accountId || parent.date !== row.date) invalid();
    totals.set(parent.id, money((totals.get(parent.id) ?? 0) + row.amount));
  }
  for (const row of rows) if (row.isParent && totals.get(row.id) !== row.amount) invalid();
  return {
    id: randomUUID(), householdId: config.householdId, budgetId: config.actual.budgetId,
    period: { ...period }, timezone: config.timezone, currency: config.currency,
    syncedAt, createdAt: new Date().toISOString(), rulesVersion: '1',
    coverage: { complete: failedAccountIds.length === 0, failedAccountIds: [...failedAccountIds] },
    accounts: normalizedAccounts,
    categories: unique(categories.map(c => ({ id: id(c.id), name: text(c.name, 500), groupId: nullableId(c.group_id), isIncome: flag(c.is_income), hidden: flag(c.hidden) }))),
    categoryGroups: unique(categoryGroups.map(g => ({ id: id(g.id), name: text(g.name, 500), isIncome: flag(g.is_income), hidden: flag(g.hidden) }))),
    payees: unique(payees.map(p => ({ id: id(p.id), name: text(p.name, 500), transferAccountId: nullableId(p.transfer_acct) }))),
    transactions: rows, budgetMonths: normalizeBudgetMonths(budgetMonths, period)
  };
}
