import { createHash } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { transactionFingerprint } from '../actual/transaction.mjs';
import { resolveCategoryName } from '../finance/categories.mjs';
import { normalizeText } from '../finance/periods.mjs';

export const TRANSACTION_SCAN_INTERVAL_MS = 15 * 60 * 1000;
export const TRANSACTION_SCAN_LOOKBACK_MONTHS = 12;
export const TRANSACTION_SCAN_AUTOMATIC_LIMIT = 20;
export const TRANSACTION_SCAN_QUESTION_LIMIT = 3;

export const monitorKey = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function assertMonitorSnapshot(snapshot, config, period) {
  if (snapshot?.householdId !== config.householdId || snapshot?.budgetId !== config.actual.budgetId ||
      snapshot?.timezone !== config.timezone || snapshot?.currency !== config.currency ||
      snapshot?.period?.start !== period.start || snapshot?.period?.end !== period.end ||
      snapshot?.rulesVersion !== '1' || snapshot?.transactionMetadataVersion !== '1' ||
      typeof snapshot?.id !== 'string' || !snapshot.id || !Number.isFinite(Date.parse(snapshot?.syncedAt)) ||
      snapshot?.coverage?.complete !== true || !Array.isArray(snapshot.coverage.failedAccountIds) || snapshot.coverage.failedAccountIds.length ||
      !Array.isArray(snapshot.transactions) || !Array.isArray(snapshot.accounts) || !Array.isArray(snapshot.payees) ||
      !Array.isArray(snapshot.categories) || !Array.isArray(snapshot.categoryGroups)) throw new AppError('SNAPSHOT_INVALID');
  if (new Set(snapshot.transactions.map(row => row?.id)).size !== snapshot.transactions.length) throw new AppError('SNAPSHOT_INVALID');
  const context = { householdId: config.householdId, budgetId: config.actual.budgetId };
  for (const transaction of snapshot.transactions) transactionFingerprint(context, transaction);
  return snapshot;
}

export function monitorInspection(snapshot, transaction, config) {
  const account = snapshot.accounts.find(row => row.id === transaction.accountId) ?? null;
  const payee = snapshot.payees.find(row => row.id === transaction.payeeId) ?? null;
  const groups = new Map(snapshot.categoryGroups.map(row => [row.id, row]));
  const categories = snapshot.categories.map(row => ({ ...row, hidden: row.hidden || !groups.has(row.groupId) || groups.get(row.groupId).hidden }));
  const context = { householdId: config.householdId, budgetId: config.actual.budgetId };
  const reason = transaction.amount >= 0 ? 'not_expense'
    : transaction.categoryId !== null ? 'categorized'
      : transaction.isParent || transaction.isChild || transaction.parentId ? 'split'
        : transaction.transferId || payee?.transferAccountId ? 'transfer'
          : transaction.startingBalance ? 'starting_balance'
            : !account ? 'missing_account'
              : account.closed ? 'closed_account'
                : account.offBudget ? 'off_budget'
                  : transaction.payeeId && !payee ? 'missing_payee' : null;
  return {
    context, transaction, account, payee, categoryGroups: snapshot.categoryGroups, categories,
    fingerprint: transactionFingerprint(context, transaction), eligibility: { eligible: reason === null, reason }
  };
}

// A memory is explanatory context only. It is deliberately not accepted by
// recommendCategories and therefore cannot affect score, source or automation.
export function memoryHint(memories, inspection) {
  const merchant = normalizeText(inspection.payee?.name ?? '');
  if (!merchant) return null;
  const visibleExpenses = inspection.categories.filter(category => !category.hidden && !category.isIncome);
  const matches = [];
  for (const memory of memories ?? []) {
    if (memory.kind !== 'classification_hint' || !memory.merchantPattern || !memory.categoryName) continue;
    const pattern = normalizeText(memory.merchantPattern);
    if (!pattern || !merchant.includes(pattern)) continue;
    const resolved = resolveCategoryName(memory.categoryName, visibleExpenses);
    matches.push({ memoryId: memory.id, subject: memory.subject, categoryName: memory.categoryName, categoryId: resolved.category?.id ?? null, resolution: resolved.category ? 'exact' : resolved.reason });
  }
  return matches.length === 1 ? matches[0] : matches.length ? { resolution: 'conflict', count: matches.length } : null;
}
