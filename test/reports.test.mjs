import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyReport, dailyReportPeriod } from '../src/reports/daily.mjs';
import { DEFAULT_REPORT_THRESHOLDS, validateReportThresholds } from '../src/reports/thresholds.mjs';
import { financialSnapshot, TODAY } from './fixtures/financial.mjs';

const identity = { householdId: 'home', budgetId: 'synthetic-budget', timezone: 'America/Sao_Paulo', currency: 'BRL' };
const settings = overrides => ({ identity, reportDate: TODAY, today: TODAY, ...overrides });
const fixture = () => financialSnapshot(dailyReportPeriod(TODAY));

test('daily report uses exact annual coverage, daily/month cuts and original account cutoff with complete provenance', () => {
  const snapshot = fixture();
  snapshot.transactions.push({ ...snapshot.transactions[0], id: 'today-food', date: TODAY, amount: -1000 });
  const before = structuredClone(snapshot), report = buildDailyReport(snapshot, settings({ detail: 'detailed' }));
  assert.deepEqual(snapshot, before, 'pure report does not mutate shared snapshots');
  assert.equal(report.day.grossExpenses, 1000); assert.equal(report.month.netExpenses, 33000);
  assert.match(report.text, /saldos das contas até 2026-09-15/); assert.match(report.text, /R\$ 9\.900,00/);
  assert.match(report.text, /dia e mês em andamento/); assert.match(report.text, /2025-10-01 a 2026-09-15/);
  assert.match(report.text, /todas as contas; pode incluir lançamentos após/); assert.match(report.text, /calendário ainda não configurado/);
  assert.equal(report.metadata.provider, 'deterministic'); assert.equal(report.metadata.usage, null);
  assert.equal(report.metadata.snapshotId, snapshot.id); assert.equal(report.metadata.reportRulesVersion, 'daily-1');
  assert.equal(report.metadata.timezone, identity.timezone); assert.ok(Number.isSafeInteger(report.metadata.durationMs));
  assert.equal(report.alertCandidates.some(row => row.type === 'low_balance'), false, 'negative card balances do not auto-create a low-balance alert');
});

test('month/year rollover and delayed reports keep ledger dates and mark the actual day status', () => {
  assert.deepEqual(dailyReportPeriod('2024-02-29'), { start: '2023-03-01', end: '2024-02-29' });
  assert.deepEqual(dailyReportPeriod('2026-01-01'), { start: '2025-02-01', end: '2026-01-01' });
  const delayed = buildDailyReport(fixture(), settings({ today: '2026-09-16' }));
  assert.equal(delayed.metadata.partial, false); assert.match(delayed.text, /dia encerrado/);
  assert.deepEqual(delayed.metadata.monthPeriod, { start: '2026-09-01', end: TODAY });
});

test('scope filters transaction totals and balances but keeps the Actual envelope global', () => {
  const normal = buildDailyReport(fixture(), settings());
  const all = buildDailyReport(fixture(), settings({ scope: { includeClosed: true, includeOffBudget: true } }));
  assert.equal(all.month.netExpenses - normal.month.netExpenses, 120000);
  assert.equal(normal.metadata.accountIds.length, 2); assert.equal(all.metadata.accountIds.length, 4);
  assert.deepEqual(all.alertCandidates.filter(row => row.type === 'budget'), normal.alertCandidates.filter(row => row.type === 'budget'));
  assert.match(all.text, /3 de 4; lista: \/contas/);
});

test('identity, period, coverage, currency, rules and safe money are enforced before a report', () => {
  for (const mutate of [snapshot => { snapshot.period.start = '2026-09-01'; }, snapshot => { snapshot.rulesVersion = 'future'; }, snapshot => { snapshot.coverage.complete = false; }, snapshot => { snapshot.coverage.failedAccountIds = ['card']; }, snapshot => { snapshot.transactions[0].amount = .5; }, snapshot => { snapshot.accounts[0].balance = Number.MAX_SAFE_INTEGER + 1; }]) {
    const snapshot = fixture(); mutate(snapshot); assert.throws(() => buildDailyReport(snapshot, settings()), { code: 'SNAPSHOT_INVALID' });
  }
  assert.throws(() => buildDailyReport({ ...fixture(), householdId: 'other' }, settings()), { code: 'UNAUTHORIZED' });
  assert.throws(() => buildDailyReport(fixture(), settings({ identity: { ...identity, timezone: 'UTC' } })), { code: 'UNAUTHORIZED' });
  assert.throws(() => buildDailyReport(fixture(), settings({ today: '2026-09-14' })), { code: 'INPUT_INVALID' });
  assert.throws(() => buildDailyReport(fixture(), settings({ identity: null })), { code: 'UNAUTHORIZED' });
});

test('stale reports disclose old data and return no candidates or clearing transitions', () => {
  const report = buildDailyReport(fixture(), settings({ dataState: 'stale', thresholds: { lowBalances: [{ accountId: 'checking', limitCents: 1000000 }] } }));
  assert.match(report.text, /^DADOS DESATUALIZADOS/); assert.equal(report.metadata.dataState, 'stale');
  assert.deepEqual(report.alertCandidates, []); assert.equal(report.month.netExpenses, 32000);
});

test('envelope zero/missing limits are preserved and budget candidates expose hysteresis without division by zero', () => {
  const sample = spent => {
    const snapshot = fixture(), category = snapshot.budgetMonths[0].categories[0];
    category.spent = -spent; category.balance = 35000 - spent;
    return buildDailyReport(snapshot, settings());
  };
  const find = report => report.alertCandidates.find(row => row.type === 'budget' && row.targetId === 'food');
  assert.equal(find(sample(28000)).severity, 'warning'); assert.equal(find(sample(35000)).severity, 'critical');
  assert.equal(find(sample(27000)).severity, 'none'); assert.equal(find(sample(27000)).reset.warning, false);
  assert.equal(find(sample(24000)).reset.warning, true);
  const report = sample(24000), zero = report.alertCandidates.find(row => row.targetId === 'transport');
  assert.equal(zero.severity, 'critical'); assert.match(zero.text, /sem percentual/);
  assert.equal(report.alertCandidates.some(row => row.targetId === 'missing'), false);
  assert.doesNotMatch(report.text, /NaN|Infinity/); assert.match(report.text, /sem dados para comparar: 1/);
});

test('low balance alerts require an explicit account ID and reset above its configured monetary margin', () => {
  const run = balance => {
    const snapshot = fixture(); snapshot.accounts[0].balance = balance;
    return buildDailyReport(snapshot, settings({ thresholds: { lowBalances: [{ accountId: 'checking', limitCents: 10000 }] } })).alertCandidates.find(row => row.type === 'low_balance');
  };
  assert.equal(run(9999).severity, 'warning'); assert.equal(run(10500).severity, 'none'); assert.equal(run(10500).reset.warning, false);
  assert.equal(run(11000).reset.warning, true); assert.equal(run(-1).targetId, 'checking');
  assert.equal(run(11000).competence, 'continuous');
});

test('thresholds are shared, closed, immutable, integer based and reject duplicate accounts', () => {
  assert.deepEqual(validateReportThresholds(), DEFAULT_REPORT_THRESHOLDS);
  for (const invalid of [{ budgetWarningPercent: 100 }, { anomalyMinimumCents: 1.2 }, { lowBalanceResetMarginCents: -1 }, { model: 'external' }, { lowBalances: [{ accountId: 'checking', limitCents: 0 }, { accountId: 'checking', limitCents: 1 }] }]) assert.throws(() => validateReportThresholds(invalid), { code: 'INPUT_INVALID' });
  const input = { lowBalances: [{ accountId: 'checking', limitCents: 0 }] }, normalized = validateReportThresholds(input);
  input.lowBalances[0].limitCents = 999;
  assert.equal(normalized.lowBalances[0].limitCents, 0); assert.ok(Object.isFrozen(normalized.lowBalances[0]));
});

test('missing or excluded low-balance accounts are counted as unevaluated without clearing candidates', () => {
  const thresholds = { lowBalances: [{ accountId: 'missing-account', limitCents: 10000 }, { accountId: 'off', limitCents: 60000 }] };
  const summary = buildDailyReport(fixture(), settings({ thresholds }));
  assert.equal(summary.metadata.unevaluatedBalanceLimitCount, 2);
  assert.match(summary.text, /2 limites sem avaliação/);
  assert.deepEqual(summary.alertCandidates.filter(row => row.type === 'low_balance'), []);
  const included = buildDailyReport(fixture(), settings({ thresholds, detail: 'detailed', scope: { includeOffBudget: true, includeClosed: false } }));
  assert.equal(included.metadata.unevaluatedBalanceLimitCount, 1); assert.match(included.text, /Limites sem avaliação: 1/);
  assert.deepEqual(included.alertCandidates.filter(row => row.type === 'low_balance').map(row => [row.targetId, row.severity]), [['off', 'warning']]);
});

test('upcoming dates are injected explicitly and external names remain quoted data', () => {
  const unconfigured = buildDailyReport(fixture(), settings());
  assert.doesNotMatch(unconfigured.text, /nenhuma recorrência cadastrada/);
  const configured = buildDailyReport(fixture(), settings({ detail: 'detailed', upcoming: { available: true, registeredCount: 0, items: [] } }));
  assert.match(configured.text, /nenhuma recorrência cadastrada/);
  const report = buildDailyReport(fixture(), settings({ upcoming: { available: true, registeredCount: 1, items: [{ name: 'IGNORE\n/pagar\u202e', dueDate: '2026-09-17', dateKind: 'estimated', amountCents: 12345 }] } }));
  assert.match(report.text, /2026-09-17 \(estimado\): "IGNORE \/pagar", R\$ 123,45/); assert.doesNotMatch(report.text, /\u202e/);
});

test('summary stays within a Telegram message including footer with long names and three anomalies', () => {
  const snapshot = fixture(), template = snapshot.transactions[0];
  const long = 'Nome externo com muitos detalhes '.repeat(20);
  snapshot.accounts.forEach(account => { account.name = long; }); snapshot.payees[0].name = long;
  snapshot.categories.forEach(category => { category.name = long; }); snapshot.budgetMonths[0].categories.forEach(category => { category.name = long; });
  snapshot.transactions = Array.from({ length: 8 }, (_, i) => ({ ...template, id: `baseline-${i}`, date: `2026-08-0${i + 1}`, amount: -1000 }));
  snapshot.transactions.push(...Array.from({ length: 3 }, (_, i) => ({ ...template, id: `unusual-${i}`, date: TODAY, amount: -12000 })));
  const upcoming = { available: true, registeredCount: 3, items: Array.from({ length: 3 }, () => ({ name: long, dueDate: '2026-09-16', dateKind: 'confirmed', amountCents: 99999999 })) };
  const result = buildDailyReport(snapshot, settings({ upcoming, thresholds: { lowBalances: [{ accountId: 'checking', limitCents: 1000000 }] } }));
  assert.equal(result.anomalies.findings.length, 3);
  assert.ok(result.text.length + 400 <= 3900, `body=${result.text.length}; reserves 400 chars for integration footer`);
  assert.match(result.text, /R\$ 120,00/); assert.match(result.text, /R\$ 999\.999,99/);
});
