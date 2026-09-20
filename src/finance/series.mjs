import { AppError } from '../errors.mjs';
import { validatePeriod } from '../actual/snapshot.mjs';
import { add, subtract } from './money.mjs';
import { normalizeText } from './periods.mjs';
import { validateScope } from './analyze.mjs';

const invalid = (code = 'INPUT_INVALID') => { throw new AppError(code); };
const cleanName = value => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) invalid();
  return value.normalize('NFKC').trim();
};
const flag = value => value == null || value === false || value === 0 ? false : value === true || value === 1 ? true : invalid('SNAPSHOT_INVALID');

export function seriesRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['period', 'categoryName', 'scope'].includes(key))) invalid();
  validatePeriod(input.period);
  return { period: { start: input.period.start, end: input.period.end }, categoryName: cleanName(input.categoryName), scope: validateScope(input.scope) };
}

function catalogOption(category, groups) {
  return { name: category.name, groupName: groups.get(category.groupId)?.name ?? 'Sem grupo', hidden: category.hidden === true };
}

export function resolveSeriesCategory(input, categories, categoryGroups) {
  const requested = cleanName(input);
  if (![categories, categoryGroups].every(Array.isArray)) invalid('SNAPSHOT_INVALID');
  const groups = new Map(categoryGroups.map(group => [group.id, group]));
  const expenses = categories.filter(category => category?.isIncome !== true && typeof category?.name === 'string');
  const literal = expenses.filter(category => normalizeText(category.name) === normalizeText(requested));
  const qualified = [];
  for (let separator = requested.indexOf(' :: '); separator >= 0; separator = requested.indexOf(' :: ', separator + 4)) {
    const categoryName = requested.slice(0, separator).trim(), groupName = requested.slice(separator + 4).trim();
    if (!categoryName || !groupName) continue;
    qualified.push(...expenses.filter(category => normalizeText(category.name) === normalizeText(categoryName) && normalizeText(groups.get(category.groupId)?.name ?? 'Sem grupo') === normalizeText(groupName)));
  }
  const exact = [...new Map([...literal, ...qualified].map(category => [category.id, category])).values()];
  if (exact.length === 1) return { category: exact[0], groupName: groups.get(exact[0].groupId)?.name ?? 'Sem grupo' };
  const candidates = exact.length > 1 ? exact : expenses.filter(category => normalizeText(category.name).includes(normalizeText(requested)) || normalizeText(requested).includes(normalizeText(category.name)));
  const options = candidates.map(category => catalogOption(category, groups)).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.groupName.localeCompare(b.groupName, 'pt-BR')).slice(0, 12);
  return { reason: exact.length > 1 ? 'ambiguous' : 'not_found', requested, options };
}

export function monthKeys(period) {
  validatePeriod(period);
  const cursor = new Date(`${period.start.slice(0, 7)}-01T12:00:00Z`), end = period.end.slice(0, 7), result = [];
  while (true) {
    const month = cursor.toISOString().slice(0, 7);
    result.push(month);
    if (month === end) break;
    if (result.length >= 24) invalid();
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return result;
}

export function buildMonthlySpendingSeries({ request, category, groupName, accounts, payees, transactions, syncedAt, identity }) {
  const { period, scope } = seriesRequest(request);
  if (!category || category.isIncome === true || typeof category.name !== 'string' || !Array.isArray(accounts) || !Array.isArray(payees) || !Array.isArray(transactions) || !identity || !Number.isFinite(Date.parse(syncedAt))) invalid('SNAPSHOT_INVALID');
  const selectedAccounts = new Set(accounts.filter(account => (scope.includeClosed || !flag(account.closed)) && (scope.includeOffBudget || !flag(account.offBudget))).map(account => account.id));
  const transferPayees = new Set(payees.filter(payee => payee.transferAccountId != null).map(payee => payee.id));
  const rows = new Map(monthKeys(period).map(month => [month, { month, grossCents: 0, refundCents: 0, netCents: 0, count: 0 }]));
  const excluded = { parents: 0, transfers: 0, accounts: 0 };
  for (const transaction of transactions) {
    if (!transaction || typeof transaction.id !== 'string' || typeof transaction.date !== 'string' || transaction.date < period.start || transaction.date > period.end || !Number.isSafeInteger(transaction.amountCents) || transaction.categoryId !== category.id) invalid('SNAPSHOT_INVALID');
    if (flag(transaction.isParent)) { excluded.parents++; continue; }
    if (transaction.transferId != null || transferPayees.has(transaction.payeeId)) { excluded.transfers++; continue; }
    if (!selectedAccounts.has(transaction.accountId)) { excluded.accounts++; continue; }
    const month = rows.get(transaction.date.slice(0, 7));
    if (!month) invalid('SNAPSHOT_INVALID');
    month.count++;
    if (transaction.amountCents < 0) month.grossCents = add(month.grossCents, -transaction.amountCents);
    else if (transaction.amountCents > 0) month.refundCents = add(month.refundCents, transaction.amountCents);
    month.netCents = subtract(month.grossCents, month.refundCents);
  }
  const months = [...rows.values()];
  const totalGrossCents = months.reduce((sum, row) => add(sum, row.grossCents), 0);
  const totalRefundCents = months.reduce((sum, row) => add(sum, row.refundCents), 0);
  const totalNetCents = subtract(totalGrossCents, totalRefundCents);
  const averageNetCents = Math.round(totalNetCents / months.length);
  if (!Number.isSafeInteger(averageNetCents)) invalid('SNAPSHOT_INVALID');
  return {
    kind: 'monthly_spending_series', status: 'ok', period, currency: 'BRL', syncedAt,
    householdId: identity.householdId, budgetId: identity.budgetId,
    category: { name: category.name, groupName }, scope, months,
    totals: { grossCents: totalGrossCents, refundCents: totalRefundCents, netCents: totalNetCents, averageNetCents }, excluded
  };
}
