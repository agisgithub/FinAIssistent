import { AppError, errorCode } from '../errors.mjs';
import { analyzeSnapshot, DEFAULT_SCOPE, validateScope } from '../finance/analyze.mjs';
import { validateIntent } from '../llm/contracts.mjs';

export const PAGE_SIZE = 10;
export function pageItems(items, page, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) throw new AppError('INPUT_INVALID');
  const start = (page - 1) * size;
  return { items: items.slice(start, start + size), page, pages, total: items.length, first: items.length ? start + 1 : 0, last: Math.min(items.length, start + size) };
}
function latestCompatibleSnapshot(store, config, intent, scope) {
  const row = store.db.prepare(`SELECT payload FROM snapshots
    WHERE household_id=? AND budget_id=?
      AND json_extract(payload,'$.period.start')=? AND json_extract(payload,'$.period.end')=?
      AND json_extract(payload,'$.timezone')=? AND json_extract(payload,'$.currency')=?
      AND json_extract(payload,'$.rulesVersion')='1'
      AND json_extract(payload,'$.coverage.complete')=1 AND json_array_length(payload,'$.coverage.failedAccountIds')=0
      AND json_extract(payload,'$.queryScope.includeClosed')=? AND json_extract(payload,'$.queryScope.includeOffBudget')=?
    ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(config.householdId, config.actual.budgetId, intent.period.start, intent.period.end, config.timezone, config.currency, scope.includeClosed ? 1 : 0, scope.includeOffBudget ? 1 : 0);
  return row ? JSON.parse(row.payload) : null;
}
export async function executeQuery(input, { config, store, actual, today }) {
  const intent = validateIntent(input, { today });
  if (intent.kind === 'unsupported') throw new AppError('INPUT_INVALID');
  const scope = validateScope(store.getPreference('finance_scope', DEFAULT_SCOPE));
  // Always read fresh full coverage, so retroactive changes invalidate all facts.
  let snapshot, dataState = 'fresh';
  try { snapshot = await actual.snapshot(intent.period); }
  catch (error) {
    const code = errorCode(error);
    const previous = ['ACTUAL_FAILED', 'ACTUAL_SYNC_FAILED', 'ACTUAL_TIMEOUT', 'NETWORK_FAILED'].includes(code) ? latestCompatibleSnapshot(store, config, intent, scope) : null;
    if (!previous) return { kind: intent.kind, unavailable: true, code, period: intent.period, lastSnapshotAt: store.latestSnapshot()?.syncedAt ?? null };
    snapshot = previous; dataState = 'stale';
  }
  if (snapshot.householdId !== config.householdId || snapshot.budgetId !== config.actual.budgetId || snapshot.timezone !== config.timezone || snapshot.currency !== config.currency) throw new AppError('UNAUTHORIZED');
  if (snapshot.coverage?.complete !== true) {
    if (dataState === 'fresh') store.saveSnapshot({ ...snapshot, queryScope: scope });
    return { kind: intent.kind, incomplete: true, snapshotId: snapshot.id, period: intent.period };
  }
  const analysis = analyzeSnapshot(snapshot, { period: intent.period, scope, today });
  if (dataState === 'fresh') store.saveSnapshot({ ...snapshot, queryScope: scope });
  analysis.metadata.dataState = dataState;
  const collection = intent.kind === 'accounts' ? analysis.accounts : intent.kind === 'uncategorized' ? analysis.uncategorized : intent.kind === 'budget' ? analysis.budgets : analysis.byCategory;
  return { kind: intent.kind, intent, analysis, listing: pageItems(collection, intent.page) };
}
