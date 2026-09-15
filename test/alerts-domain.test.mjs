import test from 'node:test';
import assert from 'node:assert/strict';
import { financialSnapshot, TODAY } from './fixtures/financial.mjs';
import { buildDailyReport, dailyReportPeriod } from '../src/reports/daily.mjs';
import { analyzeAnomalies } from '../src/finance/anomalies.mjs';
import { analyzeSnapshot } from '../src/finance/analyze.mjs';

const identity = { householdId: 'home', budgetId: 'synthetic-budget', timezone: 'America/Sao_Paulo', currency: 'BRL' };
function fixture(count = 8) {
  const snapshot = financialSnapshot(dailyReportPeriod(TODAY)), base = snapshot.transactions[0];
  snapshot.transactions = Array.from({ length: count }, (_, index) => ({ ...base, id: `base-${index}`, date: `2026-08-${String(index + 1).padStart(2, '0')}`, amount: -1000 }));
  snapshot.transactions.push({ ...base, id: 'target', date: TODAY, amount: -12000 });
  return snapshot;
}
const run = (snapshot, extra) => buildDailyReport(snapshot, { identity, reportDate: TODAY, today: TODAY, ...extra });
const anomaly = result => result.alertCandidates.find(row => row.type === 'anomaly' && row.targetId === 'target');

test('robust anomaly uses prior comparable IDs, median/MAD floor and identifiable quoted ledger fields', () => {
  const result = run(fixture()), found = result.anomalies.findings[0];
  assert.equal(found.targetId, 'target'); assert.equal(found.sampleSize, 8); assert.equal(found.medianCents, 1000); assert.equal(found.madCents, 0); assert.equal(found.thresholdCents, 6000);
  assert.equal(anomaly(result).severity, 'warning'); assert.match(found.text, /2026-09-15.*Loja fictícia.*Conta fictícia.*R\$ 120,00/);
  assert.match(result.text, /17\/08\/2026 a 15\/09\/2026/);
  assert.match(run(fixture(), { detail: 'detailed' }).text, /Desvio absoluto mediano \(MAD\)/);
});

test('same-day observations, different IDs, income reversals, parents and transfers cannot manufacture a baseline', () => {
  const snapshot = fixture(7), target = snapshot.transactions.at(-1);
  snapshot.transactions.push(...Array.from({ length: 10 }, (_, index) => ({ ...target, id: `same-day-${index}`, amount: -1000 })));
  assert.equal(run(snapshot).anomalies.findings.length, 0);
  for (const mutate of [row => { row.payeeId = 'other'; }, row => { row.accountId = 'card'; }, row => { row.categoryId = 'income'; }, row => { row.isParent = true; }, row => { row.transferId = 'pair'; }]) {
    const sample = fixture(8); mutate(sample.transactions[0]);
    assert.equal(run(sample).anomalies.findings.length, 0);
  }
});

test('delayed imports and retroactive edits that were previously ordinary are evaluated within the recent window', () => {
  const snapshot = fixture(); snapshot.transactions.at(-1).date = '2026-09-14'; snapshot.transactions.at(-1).amount = -1000;
  assert.equal(run(snapshot).anomalies.findings.length, 0);
  snapshot.transactions.at(-1).amount = -12000;
  const revised = run(snapshot); assert.equal(revised.anomalies.findings[0].date, '2026-09-14'); assert.equal(anomaly(revised).competence, '2026-09-14');
  snapshot.transactions.push({ ...snapshot.transactions.at(-1), id: 'imported-late', date: '2026-09-13', amount: -13000 });
  assert.ok(run(snapshot).anomalies.findings.some(item => item.targetId === 'imported-late'));
});

test('tracked anomalies clear only on known comparable recovery or absence inside complete coverage', () => {
  const trackedAlerts = [{ type: 'anomaly', targetId: 'target', competence: TODAY }], snapshot = fixture();
  snapshot.transactions.at(-1).amount = -5700;
  const near = anomaly(run(snapshot, { trackedAlerts })); assert.equal(near.severity, 'none'); assert.equal(near.reset.warning, false);
  snapshot.transactions.at(-1).amount = -5400;
  assert.equal(anomaly(run(snapshot, { trackedAlerts })).reset.warning, true);
  snapshot.transactions.pop();
  assert.equal(anomaly(run(snapshot, { trackedAlerts })).severity, 'none'); assert.equal(anomaly(run(snapshot, { trackedAlerts })).reset.warning, true);
  assert.equal(anomaly(run(snapshot, { trackedAlerts: [{ ...trackedAlerts[0], competence: '2025-09-01' }] })), undefined);
  assert.equal(anomaly(run(fixture(7), { trackedAlerts })), undefined, 'insufficient history cannot establish statistical recovery');
  const unknownPayee = fixture(); unknownPayee.transactions.at(-1).payeeId = 'missing';
  assert.equal(anomaly(run(unknownPayee, { trackedAlerts })), undefined, 'unknown references cannot reset an existing alert');
  assert.equal(run(unknownPayee).anomalies.insufficient, 1);
  assert.deepEqual(run(snapshot, { trackedAlerts, dataState: 'stale' }).alertCandidates, []);
});

test('outlier history does not move the robust median, while unknown payees and excluded accounts do not create alerts', () => {
  const snapshot = fixture(9); snapshot.transactions[8].amount = -1000000;
  assert.equal(run(snapshot).anomalies.findings.find(item => item.targetId === 'target').medianCents, 1000);
  snapshot.transactions.at(-1).payeeId = 'missing'; assert.equal(anomaly(run(snapshot)), undefined);
  snapshot.transactions.at(-1).payeeId = 'shop'; snapshot.transactions.at(-1).accountId = 'off';
  assert.equal(anomaly(run(snapshot)), undefined);
});

test('a tracked transaction re-dated into coverage is evaluated under its original alert key', () => {
  const trackedAlerts = [{ type: 'anomaly', targetId: 'target', competence: '2024-09-15' }];
  const result = run(fixture(), { trackedAlerts });
  assert.equal(result.anomalies.findings[0].targetId, 'target');
  assert.equal(result.anomalies.findings[0].date, TODAY);
  assert.equal(anomaly(result).severity, 'warning'); assert.equal(anomaly(result).competence, '2024-09-15');
  assert.equal(result.alertCandidates.filter(row => row.type === 'anomaly' && row.targetId === 'target').length, 1);
});

test('anomaly bounds use BigInt beyond safe cent range without fake thresholds or overflow', () => {
  const analysis = analyzeSnapshot(fixture(), { today: TODAY });
  for (const row of analysis.includedTransactions) row.amount = -Number.MAX_SAFE_INTEGER;
  const result = analyzeAnomalies(analysis, { reportDate: TODAY });
  assert.equal(result.findings.length, 0); assert.equal(result.alertCandidates[0].severity, 'none');
  assert.equal(result.alertCandidates[0].observedValue, Number.MAX_SAFE_INTEGER);
});
