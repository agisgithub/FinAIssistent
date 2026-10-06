import { createHash } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { validDate } from './snapshot.mjs';

const invalid = () => { throw new AppError('INPUT_INVALID'); };
export const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const id = value => validId(value) ? value : invalid();
const optionalId = value => value == null || value === '' ? null : id(value);
const flag = value => value == null || value === false || value === 0 ? false : value === true || value === 1 ? true : invalid();
const text = (value, max) => typeof value === 'string' && value.length <= max ? value : invalid();
export const TRANSACTION_FIELDS = Object.freeze(['id', 'account', 'date', 'amount', 'payee', 'notes', 'category', 'is_parent', 'is_child', 'parent_id', 'transfer_id', 'cleared', 'reconciled', 'starting_balance_flag', 'schedule']);

export function canonicalTransaction(row) {
  if (!row || !validDate(row.date) || !Number.isSafeInteger(row.amount)) invalid();
  return {
    id: id(row.id), accountId: id(row.account), date: row.date, amount: row.amount,
    payeeId: optionalId(row.payee), notes: text(row.notes ?? '', 10000), categoryId: optionalId(row.category),
    isParent: flag(row.is_parent), isChild: flag(row.is_child), parentId: optionalId(row.parent_id),
    transferId: optionalId(row.transfer_id), cleared: flag(row.cleared), reconciled: flag(row.reconciled),
    startingBalance: flag(row.starting_balance_flag), scheduleId: optionalId(row.schedule)
  };
}

// Fixed order and version: shared by approval, mutation and reconciliation.
export function transactionFingerprint(context, transaction) {
  const canonical = canonicalTransaction({
    id: transaction.id, account: transaction.accountId, date: transaction.date, amount: transaction.amount,
    payee: transaction.payeeId, notes: transaction.notes, category: transaction.categoryId,
    is_parent: transaction.isParent, is_child: transaction.isChild, parent_id: transaction.parentId,
    transfer_id: transaction.transferId, cleared: transaction.cleared, reconciled: transaction.reconciled,
    starting_balance_flag: transaction.startingBalance, schedule: transaction.scheduleId
  });
  return createHash('sha256').update(JSON.stringify({ version: 1, householdId: id(context.householdId), budgetId: id(context.budgetId), transaction: canonical })).digest('hex');
}

export function validateChange(input) {
  if (!input || Array.isArray(input) || Object.keys(input).some(k => !['operationId', 'targetId', 'expectedFingerprint', 'categoryId', 'expectedCategory', 'context'].includes(k))) invalid();
  if (!validId(input.operationId) || !validId(input.targetId) || !(input.categoryId === null || validId(input.categoryId)) || !/^[a-f0-9]{64}$/.test(input.expectedFingerprint)) invalid();
  if (!input.context || Object.keys(input.context).length !== 2 || !validId(input.context.householdId) || !validId(input.context.budgetId)) invalid();
  if (input.categoryId === null) { if (input.expectedCategory !== null) invalid(); }
  else {
    const category = input.expectedCategory;
    if (!category || Array.isArray(category) || Object.keys(category).length !== 5 || Object.keys(category).some(k => !['id', 'name', 'groupId', 'isIncome', 'hidden'].includes(k)) || category.id !== input.categoryId || !validId(category.groupId) || typeof category.name !== 'string' || category.name.length > 500 || typeof category.isIncome !== 'boolean' || category.hidden !== false) invalid();
  }
  return structuredClone(input);
}

export async function readTransaction(api, targetId) {
  if (!validId(targetId)) invalid();
  const result = await api.aqlQuery(api.q('transactions').filter({ id: targetId }).select([...TRANSACTION_FIELDS]).options({ splits: 'all' }));
  if (!Array.isArray(result?.data)) invalid();
  if (result.data.length === 0) throw new AppError('MUTATION_TARGET_MISSING');
  if (result.data.length !== 1 || result.data[0]?.id !== targetId) invalid();
  return canonicalTransaction(result.data[0]);
}

export async function inspectCurrent(api, config, targetId) {
  const transaction = await readTransaction(api, targetId);
  const accounts = await api.getAccounts(), categories = await api.getCategories(), groups = await api.getCategoryGroups(), payees = await api.getPayees();
  if (![accounts, categories, groups, payees].every(Array.isArray)) invalid();
  for (const rows of [accounts, categories, groups, payees]) if (new Set(rows.map(row => id(row.id))).size !== rows.length) invalid();
  const rawAccount = accounts.find(row => row.id === transaction.accountId);
  if (!rawAccount) throw new AppError('MUTATION_INELIGIBLE');
  const account = { id: id(rawAccount.id), name: text(rawAccount.name, 500), offBudget: flag(rawAccount.offbudget), closed: flag(rawAccount.closed) };
  const rawPayee = payees.find(row => row.id === transaction.payeeId);
  const payee = rawPayee ? { id: id(rawPayee.id), name: text(rawPayee.name, 500), transferAccountId: optionalId(rawPayee.transfer_acct) } : null;
  // Missing payee records are ambiguous (including deleted transfer payees).
  const reason = transaction.isParent || transaction.isChild || transaction.parentId ? 'split'
    : transaction.transferId || payee?.transferAccountId ? 'transfer'
      : transaction.startingBalance ? 'starting_balance' : account.offBudget ? 'off_budget'
        : account.closed ? 'closed_account' : transaction.payeeId && !payee ? 'missing_payee' : null;
  const context = { householdId: config.householdId, budgetId: config.actual.budgetId };
  return {
    context, transaction, account, payee,
    categoryGroups: groups.map(row => ({ id: id(row.id), name: text(row.name, 500), isIncome: flag(row.is_income), hidden: flag(row.hidden) })),
    categories: categories.map(row => {
      const group = groups.find(item => item.id === row.group_id);
      return { id: id(row.id), name: text(row.name, 500), groupId: optionalId(row.group_id), isIncome: flag(row.is_income), hidden: flag(row.hidden) || !group || flag(group.hidden) };
    }),
    fingerprint: transactionFingerprint(context, transaction), eligibility: { eligible: reason === null, reason }
  };
}
