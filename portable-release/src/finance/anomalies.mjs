import { AppError } from '../errors.mjs';
import { validDate } from '../actual/snapshot.mjs';
import { cents, formatMoney } from './money.mjs';
import { label } from '../reports/render.mjs';
import { validateReportThresholds } from '../reports/thresholds.mjs';

export const ANOMALY_MINIMUM_SAMPLE = 8;
export const alertKey = (type, targetId, competence) => JSON.stringify([type, targetId, competence]);
const median = values => {
  const sorted = [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0), middle = Math.floor(sorted.length / 2);
  // Round a half-cent median upward; BigInt avoids losing a cent at extremes.
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle] + 1n) / 2n;
};
const max = (a, b) => a > b ? a : b;
const comparableKey = row => JSON.stringify([row.accountId, row.payeeId, row.categoryId ?? null]);

// Receives the complete, validated analysis from analyzeSnapshot. Only IDs and
// amounts participate in comparison; names are presentation data.
export function analyzeAnomalies(analysis, { reportDate, thresholds, trackedAlerts = [] }) {
  thresholds = validateReportThresholds(thresholds);
  const period = analysis?.metadata?.period;
  if (!period || !validDate(reportDate) || reportDate !== period.end || analysis.metadata.complete !== true || !Array.isArray(trackedAlerts) || trackedAlerts.length > 10000) throw new AppError('INPUT_INVALID');
  const included = new Map(analysis.includedTransactions.map(row => [row.id, row]));
  const expenseCandidate = row => row && row.amount < 0 && !row.isParent && !row.transferId && !analysis.payees.get(row.payeeId)?.transferAccountId && !analysis.categories.get(row.categoryId)?.isIncome;
  const eligible = row => expenseCandidate(row) && row.payeeId && analysis.payees.has(row.payeeId) && (row.categoryId === null || analysis.categories.has(row.categoryId));
  const windowStart = new Date(`${reportDate}T12:00:00Z`); windowStart.setUTCDate(windowStart.getUTCDate() - 29);
  const window = { start: windowStart.toISOString().slice(0, 10), end: reportDate };
  const groups = new Map();
  for (const row of analysis.includedTransactions) {
    if (!eligible(row)) continue;
    cents(row.amount);
    const key = comparableKey(row), group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  const targets = new Map(), trackedIds = new Set();
  for (const alert of trackedAlerts) {
    if (!alert || alert.type !== 'anomaly' || typeof alert.targetId !== 'string' || !alert.targetId || alert.targetId.length > 128 || !validDate(alert.competence)) throw new AppError('INPUT_INVALID');
    trackedIds.add(alert.targetId);
    // Absence outside coverage proves nothing. A present transaction can have
    // been re-dated into this window; re-evaluate it using the same alert key.
    if ((alert.competence < period.start || alert.competence > period.end) && !included.has(alert.targetId)) continue;
    targets.set(alertKey('anomaly', alert.targetId, alert.competence), { targetId: alert.targetId, competence: alert.competence, tracked: true });
  }
  for (const row of analysis.includedTransactions) if (row.date >= window.start && row.date <= reportDate && expenseCandidate(row) && !trackedIds.has(row.id)) targets.set(alertKey('anomaly', row.id, row.date), { targetId: row.id, competence: row.date, tracked: false });
  const alertCandidates = [], findings = [], statisticsByDate = new Map();
  let insufficient = 0;
  for (const [key, target] of targets) {
    const row = included.get(target.targetId);
    if (expenseCandidate(row) && !eligible(row)) {
      // Unknown payee/category references cannot prove statistical recovery.
      if (row.date >= window.start) insufficient++;
      continue;
    }
    if (!eligible(row)) {
      if (target.tracked) alertCandidates.push({ key, type: 'anomaly', targetId: target.targetId, competence: target.competence, severity: 'none', reset: { warning: true, critical: true }, text: `Lançamento ${label(target.targetId, 128)} não consta como despesa comparável no intervalo coberto. Isso não comprova exclusão fora desse intervalo.` });
      continue;
    }
    const groupKey = comparableKey(row), statisticsKey = JSON.stringify([groupKey, row.date]);
    let statistics = statisticsByDate.get(statisticsKey);
    if (!statistics) {
      const sample = (groups.get(groupKey) ?? []).filter(previous => previous.id !== row.id && previous.date < row.date).map(previous => BigInt(-previous.amount));
      statistics = { sampleSize: sample.length };
      if (sample.length >= ANOMALY_MINIMUM_SAMPLE) {
        const middle = median(sample), mad = median(sample.map(value => value >= middle ? value - middle : middle - value));
        Object.assign(statistics, { middle, mad, threshold: max(middle * BigInt(thresholds.anomalyMedianMultiplier), middle + max(mad * BigInt(thresholds.anomalyMadMultiplier), BigInt(thresholds.anomalyMinimumCents))) });
      }
      statisticsByDate.set(statisticsKey, statistics);
    }
    if (statistics.sampleSize < ANOMALY_MINIMUM_SAMPLE) { if (row.date >= window.start) insufficient++; continue; }
    const { middle, mad, threshold, sampleSize } = statistics;
    const amount = BigInt(-row.amount), unusual = amount > threshold;
    // Values above MAX_SAFE_INTEGER remain BigInt comparison bounds, never
    // converted into rounded monetary output. A hit is necessarily below it.
    const text = unusual ? `Gasto incomum em ${row.date}: ${label(analysis.payees.get(row.payeeId).name)}, conta ${label(analysis.accounts.find(account => account.id === row.accountId)?.name ?? row.accountId)}, ${formatMoney(Number(amount))}; referência mediana ${formatMoney(Number(middle))} (${sampleSize} observações anteriores). Revise o lançamento ${label(row.id, 128)} no Actual.` : `Lançamento ${label(row.id, 128)} dentro do limiar estatístico atual.`;
    const candidate = { key, type: 'anomaly', targetId: row.id, competence: target.competence, severity: unusual ? 'warning' : 'none', reset: { warning: amount * 10n <= threshold * 9n, critical: true }, text, observedValue: Number(amount) };
    alertCandidates.push(candidate);
    if (unusual && row.date >= window.start) findings.push({ targetId: row.id, date: row.date, amount: Number(amount), sampleSize, medianCents: Number(middle), madCents: Number(mad), thresholdCents: Number(threshold), text });
  }
  return { findings, insufficient, alertCandidates, minimumSample: ANOMALY_MINIMUM_SAMPLE, window };
}
