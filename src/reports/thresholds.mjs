import { AppError } from '../errors.mjs';

export const DEFAULT_REPORT_THRESHOLDS = Object.freeze({
  budgetWarningPercent: 80, budgetCriticalPercent: 100, budgetResetMarginPercent: 5,
  lowBalances: Object.freeze([]), lowBalanceResetMarginCents: 1000,
  anomalyMinimumCents: 5000, anomalyMedianMultiplier: 3, anomalyMadMultiplier: 3
});
const invalid = () => { throw new AppError('INPUT_INVALID'); };
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
export function validateReportThresholds(input = DEFAULT_REPORT_THRESHOLDS) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(DEFAULT_REPORT_THRESHOLDS, key))) invalid();
  const result = { ...DEFAULT_REPORT_THRESHOLDS, ...input };
  if (!integer(result.budgetWarningPercent, 1, 1000) || !integer(result.budgetCriticalPercent, 1, 1000) || result.budgetWarningPercent >= result.budgetCriticalPercent || !integer(result.budgetResetMarginPercent, 0, result.budgetWarningPercent - 1)) invalid();
  if (!integer(result.lowBalanceResetMarginCents, 0, Number.MAX_SAFE_INTEGER) || !integer(result.anomalyMinimumCents, 1, Number.MAX_SAFE_INTEGER) || !integer(result.anomalyMedianMultiplier, 2, 20) || !integer(result.anomalyMadMultiplier, 1, 20)) invalid();
  if (!Array.isArray(result.lowBalances) || result.lowBalances.length > 100) invalid();
  result.lowBalances = result.lowBalances.map(item => {
    if (!item || Array.isArray(item) || Object.keys(item).length !== 2 || Object.keys(item).some(key => !['accountId', 'limitCents'].includes(key)) || typeof item.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.accountId) || !Number.isSafeInteger(item.limitCents)) invalid();
    return Object.freeze({ accountId: item.accountId, limitCents: item.limitCents });
  });
  if (new Set(result.lowBalances.map(item => item.accountId)).size !== result.lowBalances.length) invalid();
  return Object.freeze({ ...result, lowBalances: Object.freeze(result.lowBalances) });
}
