import { analyzeSnapshot } from './analyze.mjs';
import { comparisonPeriods } from './periods.mjs';
import { subtract, percentage } from './money.mjs';

export function compareSnapshot(snapshot, { scope, today }) {
  const ranges = comparisonPeriods(today);
  // Account balances belong to the outer snapshot cutoff. They are never
  // copied into the comparison result or relabeled as historical balances.
  const spendingFor = period => analyzeSnapshot({ ...snapshot, period, transactions: snapshot.transactions.filter(row => row.date >= period.start && row.date <= period.end), budgetMonths: [] }, { scope, period, today });
  const current = spendingFor(ranges.current), previous = spendingFor(ranges.previous);
  const ids = new Set([...current.byCategory, ...previous.byCategory].map(row => row.id));
  const currentById = new Map(current.byCategory.map(row => [row.id, row])), previousById = new Map(previous.byCategory.map(row => [row.id, row]));
  const rows = [...ids].map(id => {
    const now = currentById.get(id), before = previousById.get(id), currentNet = now?.net ?? 0, previousNet = before?.net ?? 0;
    const change = subtract(currentNet, previousNet);
    return { id, name: (now ?? before).name, currentNet, previousNet, change, newExpense: previousNet === 0 && currentNet > 0, changePercent: previousNet > 0 ? percentage(Math.abs(change), previousNet) : null };
  }).sort((a, b) => b.change - a.change || String(a.id).localeCompare(String(b.id)));
  return { ranges, current: current.totals, previous: previous.totals, rows };
}
