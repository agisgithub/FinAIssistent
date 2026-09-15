import { AppError } from '../errors.mjs';
import { validDate } from '../actual/snapshot.mjs';
import { analyzeSnapshot, DEFAULT_SCOPE, validateScope } from '../finance/analyze.mjs';
import { calendarMonths, boundedPeriod } from '../finance/periods.mjs';
import { cents, formatMoney, percentage } from '../finance/money.mjs';
import { analyzeAnomalies, alertKey } from '../finance/anomalies.mjs';
import { label } from './render.mjs';
import { validateReportThresholds } from './thresholds.mjs';
export { DEFAULT_REPORT_THRESHOLDS, validateReportThresholds } from './thresholds.mjs';

export const dailyReportPeriod = reportDate => calendarMonths(12, reportDate);
const money = value => value == null ? 'não informado' : formatMoney(value);
const candidate = (type, targetId, competence, severity, reset, text, observedValue) => ({ key: alertKey(type, targetId, competence), type, targetId, competence, severity, reset, text, observedValue });
const active = row => row.severity !== 'none';

function budgetCandidates(budgets, thresholds) {
  return budgets.flatMap(row => {
    if (row.spent == null || row.available == null) return [];
    const spent = BigInt(cents(row.spent)), available = BigInt(cents(row.available));
    let severity = 'none', reset;
    if (available <= 0n) {
      severity = spent > 0n ? 'critical' : 'none';
      reset = { warning: spent <= 0n, critical: spent <= 0n };
    } else {
      const reaches = percent => spent * 100n >= available * BigInt(percent);
      severity = reaches(thresholds.budgetCriticalPercent) ? 'critical' : reaches(thresholds.budgetWarningPercent) ? 'warning' : 'none';
      reset = { warning: !reaches(thresholds.budgetWarningPercent - thresholds.budgetResetMarginPercent), critical: !reaches(thresholds.budgetCriticalPercent - thresholds.budgetResetMarginPercent) };
    }
    const text = `Orçamento ${label(row.name)} (${row.month}): despesa líquida ${money(row.spent)}, saldo antes do consumo ${money(row.available)}, saldo do envelope ${money(row.balance)}${available > 0n ? `; uso ${percentage(Math.max(0, row.spent), row.available)}` : '; disponibilidade zero/negativa, sem percentual'}. Fonte: envelope integral do Actual, todas as contas; pode incluir datas posteriores ao relatório.`;
    return [candidate('budget', row.id, row.month, severity, reset, text, row.spent)];
  });
}
function balanceCandidates(accounts, thresholds) {
  const limits = new Map(thresholds.lowBalances.map(item => [item.accountId, item.limitCents]));
  return accounts.filter(account => limits.has(account.id)).map(account => {
    const balance = BigInt(cents(account.balance)), limit = BigInt(limits.get(account.id));
    return candidate('low_balance', account.id, 'continuous', balance < limit ? 'warning' : 'none', { warning: balance >= limit + BigInt(thresholds.lowBalanceResetMarginCents), critical: true }, `Saldo ${label(account.name)}: ${formatMoney(account.balance)}; limite configurado ${formatMoney(Number(limit))}. Confira a conta no Actual.`, account.balance);
  });
}
function upcomingText(upcoming, reportDate, size, compact = false) {
  if (upcoming == null || upcoming.available === false) return 'Próximos vencimentos: calendário ainda não configurado.';
  if (upcoming.available !== true || !Array.isArray(upcoming.items) || upcoming.items.length > 10000 || (upcoming.registeredCount != null && (!Number.isSafeInteger(upcoming.registeredCount) || upcoming.registeredCount < 0))) throw new AppError('INPUT_INVALID');
  const end = new Date(`${reportDate}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + 7);
  const through = end.toISOString().slice(0, 10);
  for (const item of upcoming.items) if (!item || typeof item.name !== 'string' || !validDate(item.dueDate) || !['confirmed', 'estimated'].includes(item.dateKind) || (item.amountCents !== null && !Number.isSafeInteger(item.amountCents))) throw new AppError('INPUT_INVALID');
  const items = upcoming.items.filter(item => item.dueDate >= reportDate && item.dueDate <= through).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  if (!items.length) return upcoming.registeredCount === 0 ? 'Próximos vencimentos — calendário local: nenhuma recorrência cadastrada.' : `Próximos vencimentos — calendário local: nenhum vencimento informado de ${reportDate} a ${through}.`;
  return `Próximos vencimentos — calendário local, ${reportDate} a ${through}:\n${items.slice(0, size).map(item => `${item.dueDate} (${item.dateKind === 'confirmed' ? 'confirmado' : 'estimado'}): ${label(item.name, compact ? 32 : 90)}, ${money(item.amountCents)}.`).join('\n')}${items.length > size ? `\nExibidos ${size} de ${items.length}; /proximos_vencimentos para a lista.` : ''}`;
}

export function buildDailyReport(snapshot, { identity, reportDate, today, scope = DEFAULT_SCOPE, dataState = 'fresh', detail = 'summary', thresholds, upcoming, trackedAlerts = [] } = {}) {
  const startedAt = performance.now();
  if (!identity || ['householdId', 'budgetId', 'timezone', 'currency'].some(key => typeof identity[key] !== 'string' || !identity[key] || snapshot?.[key] !== identity[key])) throw new AppError('UNAUTHORIZED');
  if (!validDate(reportDate) || !validDate(today) || reportDate > today || !['fresh', 'stale'].includes(dataState) || !['summary', 'detailed'].includes(detail)) throw new AppError('INPUT_INVALID');
  const period = dailyReportPeriod(reportDate);
  if (snapshot.period?.start !== period.start || snapshot.period?.end !== period.end || snapshot.rulesVersion !== '1' || snapshot.coverage?.complete !== true || snapshot.coverage.failedAccountIds?.length !== 0 || !Number.isFinite(Date.parse(snapshot.syncedAt)) || typeof snapshot.id !== 'string' || !snapshot.id) throw new AppError('SNAPSHOT_INVALID');
  try { new Intl.DateTimeFormat('en', { timeZone: identity.timezone }).format(); } catch { throw new AppError('INPUT_INVALID'); }
  scope = validateScope(scope); thresholds = validateReportThresholds(thresholds);
  const whole = analyzeSnapshot(snapshot, { period, scope, today });
  for (const account of whole.selectedAccounts) cents(account.balance);
  const dayPeriod = boundedPeriod({ start: reportDate, end: reportDate }, today), monthPeriod = boundedPeriod({ start: reportDate.slice(0, 7) + '-01', end: reportDate }, today);
  // Balances always retain the original cutoff reportDate; these recuts only
  // supply transaction totals. No earlier historical balance is manufactured.
  const recut = range => analyzeSnapshot({ ...snapshot, period: range, transactions: snapshot.transactions.filter(row => row.date >= range.start && row.date <= range.end), budgetMonths: [] }, { period: range, scope, today });
  const day = recut(dayPeriod), month = recut(monthPeriod);
  const budgets = whole.budgets.filter(row => row.month === reportDate.slice(0, 7));
  const anomalies = analyzeAnomalies(whole, { reportDate, thresholds, trackedAlerts });
  const budgetAlerts = budgetCandidates(budgets, thresholds), balanceAlerts = balanceCandidates(whole.selectedAccounts, thresholds);
  const selectedAccountIds = new Set(whole.selectedAccounts.map(account => account.id));
  const unevaluatedBalanceLimitCount = thresholds.lowBalances.filter(limit => !selectedAccountIds.has(limit.accountId)).length;
  const alertCandidates = dataState === 'fresh' ? [...budgetAlerts, ...balanceAlerts, ...anomalies.alertCandidates] : [];
  const size = detail === 'detailed' ? 10 : 3;
  const list = (rows, format, command) => rows.length ? rows.slice(0, size).map(format).join('\n') + (rows.length > size ? `\nExibidos ${size} de ${rows.length}; ${command} para a lista.` : '') : 'Nenhum item neste escopo.';
  const caution = budgetAlerts.filter(active), low = balanceAlerts.filter(active);
  const total = day.totals;
  const metadata = { ...whole.metadata, reportDate, dayPeriod, monthPeriod, dataState, partial: reportDate === today, detail, unevaluatedBalanceLimitCount, reportRulesVersion: 'daily-1', provider: 'deterministic', reason: 'daily_report', usage: null, durationMs: null };
  const brief = value => label(value, 32);
  const shortList = (rows, format, command) => rows.slice(0, 3).map(format).join('\n') + (rows.length > 3 ? `\n3 de ${rows.length}; lista: ${command}` : '');
  const lines = detail === 'summary' ? [
    dataState === 'stale' ? 'DADOS DESATUALIZADOS — último snapshot compatível; alertas não atualizados.' : '',
    `Relatório ${reportDate} — ${reportDate === today ? 'dia/mês em andamento' : 'dia encerrado'}.`,
    `Saldos até ${reportDate}:`,
    shortList(whole.selectedAccounts, account => `${brief(account.name)}: ${formatMoney(account.balance)}.`, '/contas') || 'Nenhuma conta no escopo.',
    `Dia: receitas líquidas ${formatMoney(total.netIncome)} (reversões ${formatMoney(total.incomeReversals)}); despesas líquidas ${formatMoney(total.netExpenses)} (bruto ${formatMoney(total.grossExpenses)}, estornos ${formatMoney(total.refunds)}).`,
    `Entradas sem classificação ${formatMoney(total.unclassifiedInflows)}; movimento líquido ${formatMoney(total.netMovement)}.`,
    `Mês ${monthPeriod.start} a ${reportDate}: despesas líquidas ${formatMoney(month.totals.netExpenses)}.`,
    `Orçamento: ${caution.length} categorias sinalizadas; sem dados para comparar: ${budgets.filter(row => row.spent == null || row.available == null).length}; limiares ${thresholds.budgetWarningPercent}%/${thresholds.budgetCriticalPercent}% sobre saldo antes do consumo.`,
    shortList(caution.length ? budgets.filter(row => caution.some(alert => alert.targetId === row.id)) : budgets, row => `${brief(row.name)}: saldo ${money(row.balance)}; uso ${row.utilization ?? 'não calculável'}.`, '/orcamento') || 'Envelope mensal não informado.',
    'Envelope Actual: todas as contas; pode incluir lançamentos após a data do relatório.',
    thresholds.lowBalances.length ? `Saldo baixo: ${low.length} contas com limite explícito${low.length ? ` (${low.slice(0, 3).map(row => brief(whole.accounts.find(account => account.id === row.targetId)?.name ?? row.targetId)).join(', ')})` : ''}; ${unevaluatedBalanceLimitCount} limites sem avaliação (conta ausente/fora do escopo).` : 'Saldo baixo: limites por conta não configurados.',
    `Incomuns (${anomalies.window.start} a ${reportDate}): ${anomalies.findings.length}; base insuficiente: ${anomalies.insufficient} (mín. 8 anteriores).`,
    shortList(anomalies.findings, finding => {
      const row = whole.includedTransactions.find(item => item.id === finding.targetId);
      return `${finding.date} ${brief(whole.payees.get(row.payeeId)?.name)} / ${brief(whole.accounts.find(account => account.id === row.accountId)?.name)}: ${formatMoney(finding.amount)}; mediana ${formatMoney(finding.medianCents)}.`;
    }, `/gastos ${anomalies.window.start} ${reportDate}`),
    `Sem categoria no mês: ${month.uncategorized.length}; /sem_categoria ${monthPeriod.start} ${reportDate}.`,
    upcomingText(upcoming, reportDate, 3, true),
    `Ações: ${[month.uncategorized.length ? 'revisar sem categoria' : null, caution.length ? 'conferir /orcamento' : null, low.length ? 'conferir contas sinalizadas' : null, anomalies.findings.length ? 'verificar incomuns no Actual' : null].filter(Boolean).join('; ') || 'acompanhar /resumo'}.`,
    `Actual · orçamento ${label(snapshot.budgetId, 128)} · snapshot ${label(snapshot.id, 128)} · sync ${label(snapshot.syncedAt)}.`,
    `Base completa ${period.start}–${period.end}; ${snapshot.timezone}; BRL; ${whole.selectedAccounts.length} contas no escopo (${scope.includeOffBudget ? 'inclui' : 'exclui'} fora do orçamento, ${scope.includeClosed ? 'inclui' : 'exclui'} encerradas). Regras daily-1/finance-1/normalização1.`
  ].filter(Boolean) : [
    dataState === 'stale' ? 'DADOS DESATUALIZADOS — relatório do último snapshot compatível. Nenhum alerta novo ou estado de alerta atualizado.' : '',
    `Relatório diário — ${reportDate}${reportDate === today ? ' (dia e mês em andamento)' : ' (dia encerrado; alterações retroativas podem mudar os números)'}.`,
    `Fatos — saldos das contas até ${reportDate}:`,
    list(whole.selectedAccounts, account => `${label(account.name)}: ${formatMoney(account.balance)}${account.closed ? ' (encerrada)' : ''}${account.offBudget ? ' (fora do orçamento)' : ''}.`, '/contas'),
    `Cálculos do dia: receitas categorizadas ${formatMoney(total.income)}; reversões ${formatMoney(total.incomeReversals)}; receitas líquidas ${formatMoney(total.netIncome)}.`,
    `Despesas do dia: bruto ${formatMoney(total.grossExpenses)}; estornos identificados ${formatMoney(total.refunds)}; líquido ${formatMoney(total.netExpenses)}.`,
    `Entradas sem classificação suficiente: ${formatMoney(total.unclassifiedInflows)}. Movimento líquido elegível: ${formatMoney(total.netMovement)}. Receita categorizada não prova recorrência.`,
    `Despesas no mês, ${monthPeriod.start} a ${reportDate}: líquido ${formatMoney(month.totals.netExpenses)} (bruto ${formatMoney(month.totals.grossExpenses)}; estornos ${formatMoney(month.totals.refunds)}).`,
    'Orçamento: envelope mensal integral do Actual, todas as contas; pode incluir lançamentos após a data final do relatório.',
    budgets.length ? list(budgets, row => `${label(row.name)}: alocado ${money(row.budgeted)}, despesa líquida ${money(row.spent)}, saldo ${money(row.balance)}; uso ${row.utilization ?? 'não calculável'}.`, '/orcamento') : 'Orçamento mensal não informado no snapshot.',
    `Categorias próximas/acima do limite: ${caution.length}${caution.length ? ` — ${caution.slice(0, size).map(row => label(whole.categories.get(row.targetId)?.name ?? row.targetId)).join(', ')}` : ''}. Limiares ${thresholds.budgetWarningPercent}%/${thresholds.budgetCriticalPercent}% da disponibilidade antes do consumo; zero/ausente não gera percentual.`,
    thresholds.lowBalances.length ? `Contas abaixo do limite explícito: ${low.length}${low.length ? ` — ${low.slice(0, size).map(row => label(whole.accounts.find(account => account.id === row.targetId)?.name ?? row.targetId)).join(', ')}` : ''}. Limites sem avaliação: ${unevaluatedBalanceLimitCount} (conta ausente ou fora do escopo); nenhum alerta desses limites foi encerrado.` : 'Saldo baixo: nenhum limite por conta configurado.',
    `Padrões — gastos incomuns de ${anomalies.window.start} a ${reportDate}: ${anomalies.findings.length}; base insuficiente: ${anomalies.insufficient} (mínimo de ${anomalies.minimumSample} observações anteriores).`,
    anomalies.findings.length ? list(anomalies.findings, row => row.text + (detail === 'detailed' ? ` Desvio absoluto mediano (MAD): ${formatMoney(row.madCents)}; limiar composto ${formatMoney(row.thresholdCents)}.` : ''), `/gastos ${anomalies.window.start} ${reportDate}`) : '',
    `Sem categoria no mês: ${month.uncategorized.length}. ${month.uncategorized.length ? `/sem_categoria ${monthPeriod.start} ${reportDate}` : 'Transferências e pais de split são excluídos.'}`,
    detail === 'detailed' && month.uncategorized.length ? list(month.uncategorized, row => `${row.date} — ID ${label(row.id, 128)}: ${formatMoney(row.amount)}.`, `/sem_categoria ${monthPeriod.start} ${reportDate}`) : '',
    upcomingText(upcoming, reportDate, size),
    `Ações sugeridas: ${[month.uncategorized.length ? 'revisar /sem_categoria' : null, caution.length ? 'conferir /orcamento antes de novos gastos' : null, low.length ? 'conferir os saldos e compromissos das contas sinalizadas' : null, anomalies.findings.length ? 'verificar os lançamentos incomuns no Actual' : null].filter(Boolean).join('; ') || 'consultar /resumo para acompanhar os próximos movimentos'}. Nenhuma causa de gasto, fraude ou capacidade de pagamento foi inferida.`,
    `Fonte: Actual; orçamento ${label(snapshot.budgetId, 128)}; snapshot ${label(snapshot.id, 128)}; sync ${label(snapshot.syncedAt)}.`,
    `Cobertura completa: ${period.start} a ${period.end}; fuso financeiro ${label(snapshot.timezone)}; BRL. Escopo: ${scope.includeOffBudget ? 'inclui' : 'exclui'} fora do orçamento; ${scope.includeClosed ? 'inclui' : 'exclui'} encerradas. ${whole.selectedAccounts.length} contas incluídas; ${whole.metadata.excludedAccountIds.length} excluídas.`,
    'Regras: daily-1 / finance-1 / normalização 1. Fatos, cálculos e padrões separados; hipóteses causais não confirmadas.'
  ].filter(Boolean);
  metadata.durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  return { text: lines.join('\n'), metadata, alertCandidates, anomalies: { findings: anomalies.findings, insufficient: anomalies.insufficient, window: anomalies.window }, day: day.totals, month: month.totals };
}
