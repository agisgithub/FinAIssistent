import { formatMoney, percentage } from '../finance/money.mjs';
import { COMMAND_BY_KIND } from '../application/dispatch.mjs';
import { validDate } from '../actual/snapshot.mjs';
import { ERROR_CODES } from '../errors.mjs';

export function label(value, max = 90) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return JSON.stringify(text.length > max ? text.slice(0, max) + '…' : text);
}
const moneyOrUnknown = value => value == null ? 'não informado' : formatMoney(value);
const actionId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : label(value, 128);
export const displayDate = value => validDate(value) ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : 'não informada';
export function displayTime(value, timezone = 'America/Sao_Paulo') {
  if (value == null || !Number.isFinite(new Date(value).getTime())) return 'não informado';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  const offset = parts.timeZoneName.replace('GMT', 'UTC').replace(/^UTC[+-]0$/, 'UTC');
  return `${parts.day}/${parts.month}/${parts.year} às ${parts.hour}:${parts.minute} (${offset})`;
}
const scopeLabel = scope => `${scope.includeOffBudget ? 'inclui' : 'exclui'} contas fora do orçamento; ${scope.includeClosed ? 'inclui' : 'exclui'} encerradas`;
function provenance(metadata) {
  return [
    `Fonte: Actual · ${metadata.dataState === 'stale' ? 'dados desatualizados' : 'leitura nova'}, cobertura completa.`,
    `Sincronizado em ${displayTime(metadata.syncedAt, metadata.timezone)}.`,
    metadata.currentDayPartial ? 'Dia atual em andamento; valores do mês ainda parciais.' : 'Período encerrado; alterações retroativas podem mudar uma nova consulta.',
    `Escopo: ${metadata.accountIds.length} contas incluídas; ${metadata.excludedAccountIds.length} excluídas · ${scopeLabel(metadata.scope)}. Ajuste: /escopo.`
  ].join('\n');
}
function pagination(result) {
  const { listing, kind, intent } = result;
  const lines = [`Página ${listing.page}/${listing.pages} · itens ${listing.first}–${listing.last} de ${listing.total}.${result.categoryChoice ? ' Escolha pendente, sem total calculado.' : listing.pages > 1 ? ' Totais incluem todas as páginas.' : ''}`];
  if (listing.page < listing.pages) lines.push(`Próxima: ${COMMAND_BY_KIND[kind]}${kind === 'comparison' ? '' : `${intent.categoryName ? ` com ${JSON.stringify(intent.categoryName)} |` : ''} ${intent.period.start} ${intent.period.end}`} pagina ${listing.page + 1}`);
  return lines.join('\n');
}
function financialTotals(totals) {
  return [
    `Despesas líquidas: ${formatMoney(totals.netExpenses)}.`,
    `Receitas líquidas: ${formatMoney(totals.netIncome)}.`,
    `Movimento líquido elegível: ${formatMoney(totals.netMovement)}.`,
    '', 'Detalhes do período',
    `Despesas brutas: ${formatMoney(totals.grossExpenses)}.`,
    `Estornos identificados: ${formatMoney(totals.refunds)} (entradas em categorias de despesa).`,
    `Receitas categorizadas: ${formatMoney(totals.income)}; reversões: ${formatMoney(totals.incomeReversals)}.`,
    `Entradas sem classificação suficiente: ${formatMoney(totals.unclassifiedInflows)}.`
  ].join('\n');
}
function categoryLines(items) {
  return items.map(row => `• ${label(row.name)} — ${formatMoney(row.net)} líquidos\nBruto ${formatMoney(row.gross)} · estornos ${formatMoney(row.refunds)} · ${row.count} ${row.count === 1 ? 'lançamento' : 'lançamentos'}.`).join('\n\n') || 'Nenhum movimento de despesa neste escopo.';
}
export function renderQuery(result) {
  if (result.needsInfo) {
    return result.needsInfo === 'installment' ? 'Para avaliar uma parcela, informe: renda líquida mensal estável, compromissos mensais (incluindo dívidas), reserva disponível, valor da compra, entrada, juros/CET, número de parcelas e prazo. Esses dados ainda não foram confirmados; não foi calculada viabilidade.' : 'Para preparar um plano de economia, informe: renda líquida mensal estável, compromissos mensais, reserva atual, quanto deseja economizar e em qual prazo, além dos gastos que considera ajustáveis. Esses dados ainda não foram confirmados; não foi calculada uma meta viável.';
  }
  if (result.unavailable) return `ACTUAL INDISPONÍVEL\n${displayDate(result.period.start)} a ${displayDate(result.period.end)}\n\nCódigo: ${result.code}.\nÚltima leitura disponível: ${result.lastSnapshotAt ? displayTime(result.lastSnapshotAt, result.timezone) : 'nenhuma'}.\nNão há leitura compatível para apresentar totais deste período e escopo.`;
  if (result.incomplete) return 'Consulta incompleta: uma ou mais contas não puderam ser lidas. Nenhum total completo será apresentado. Tente novamente.';
  if (result.categoryChoice) {
    const groupNames = new Map(result.categoryGroups.map(group => [group.id, group.name]));
    return [
      result.dataState === 'stale' ? 'CATÁLOGO DESATUALIZADO — Actual indisponível.' : '',
      result.categoryChoice === 'ambiguous' ? `Há mais de uma correspondência no catálogo para ${label(result.requestedCategory)}. Qual delas você quer consultar?` : `Não encontrei uma categoria de despesa com o nome exato ${label(result.requestedCategory)}. Escolha um nome do catálogo:`,
      ...result.listing.items.map(category => `${label(category.name)} — grupo ${label(groupNames.get(category.groupId) ?? 'não informado')}${category.groupId ? ` [${label(category.groupId, 128)}]` : ''}${category.hidden ? ' (oculta)' : ''}.\n/gastos com ${JSON.stringify(category.name + (category.groupId ? ` :: ${category.groupId}` : ''))} | ${result.period.start} ${result.period.end}`),
      result.categoryChoice === 'ambiguous' ? 'Se o nome se repetir no mesmo grupo ou uma escolha colidir com um nome que contém " :: ", dê nomes distintos no Actual antes de consultar; não escolherei uma automaticamente.' : '',
      pagination(result),
      `Fonte: catálogo Actual · sincronizado em ${displayTime(result.syncedAt, result.timezone)}. Nenhum total por categoria foi apresentado.`
    ].filter(Boolean).join('\n\n');
  }
  const { analysis, listing, kind } = result;
  const { totals, metadata } = analysis;
  let body;
  if (kind === 'comparison') {
    const { ranges, current, previous } = result.comparison;
    body = [
      'Cálculos — comparação mensal de despesas:',
      `Atual: ${displayDate(ranges.current.start)} a ${displayDate(ranges.current.end)} (${ranges.currentDays} dias, último dia em andamento).`,
      `Anterior: ${displayDate(ranges.previous.start)} a ${displayDate(ranges.previous.end)} (${ranges.previousDays} dias encerrados).`,
      ranges.currentDays !== ranges.previousDays ? 'O mês anterior é mais curto: as durações diferem; a variação abaixo não foi normalizada por dia.' : 'Mesmos dias do calendário; hoje ainda está parcial.',
      `Atual — bruto ${formatMoney(current.grossExpenses)}, estornos ${formatMoney(current.refunds)}, líquido ${formatMoney(current.netExpenses)}.`,
      `Anterior — bruto ${formatMoney(previous.grossExpenses)}, estornos ${formatMoney(previous.refunds)}, líquido ${formatMoney(previous.netExpenses)}.`,
      'Categorias ordenadas pela variação da despesa líquida:',
      ...listing.items.map(row => `${label(row.name)}: anterior ${formatMoney(row.previousNet)} → atual ${formatMoney(row.currentNet)}; variação ${formatMoney(row.change)}${row.newExpense ? '; novo gasto no período comparado (base anterior zero)' : row.changePercent ? `; ${row.change >= 0 ? '+' : '-'}${row.changePercent}` : '; percentual não calculado com base anterior não positiva'}.`),
      listing.total ? '' : 'Nenhuma despesa nos períodos comparados.',
      'A comparação mostra despesas; nenhum saldo de conta foi recalculado para a data anterior. Não identifica a causa do aumento.'
    ].filter(Boolean).join('\n');
  } else if (kind === 'accounts') {
    const selected = new Set(metadata.accountIds);
    body = `Saldos até ${displayDate(metadata.period.end)}\n\n` + (listing.items.map(account => `• ${label(account.name)} — ${moneyOrUnknown(account.balance)}\n${account.offBudget ? 'Fora do orçamento' : 'No orçamento'} · ${account.closed ? 'encerrada' : 'aberta'} · ${selected.has(account.id) ? 'incluída' : 'excluída'} nos cálculos.\nID: ${actionId(account.id)}`).join('\n\n') || 'Nenhuma conta.');
  } else if (kind === 'uncategorized') {
    const accounts = new Map(analysis.accounts.map(account => [account.id, account.name]));
    body = `${analysis.uncategorized.length} lançamentos sem categoria\n\n` + (listing.items.map(row => `• ${displayDate(row.date)} — ${formatMoney(row.amount)}\nFavorecido ${label(analysis.payees.get(row.payeeId)?.name ?? 'não informado')}\nConta ${label(accounts.get(row.accountId) ?? 'não informada')}\nID: ${actionId(row.id)}${row.parentId ? '\nParte de um lançamento dividido; edição somente no Actual.' : ''}`).join('\n\n') || 'Nenhum lançamento sem categoria neste escopo.');
  } else if (kind === 'budget') {
    body = [
      'Fatos do Actual — orçamento mensal:',
      'O envelope usa todas as contas do orçamento no Actual; /escopo não modifica esses valores. Os totais do mês podem conter lançamentos posteriores ao fim da consulta.',
      ...listing.items.map(row => [
        `${row.month} — ${label(row.name)}: alocado ${moneyOrUnknown(row.budgeted)}; despesa líquida mensal ${moneyOrUnknown(row.spent)}; saldo ${moneyOrUnknown(row.balance)}.`,
        `Carryover habilitado: ${row.carryover == null ? 'não informado' : row.carryover ? 'sim' : 'não'}.`,
        `Cálculo saldo antes do consumo (saldo − spent assinado): ${moneyOrUnknown(row.available)}; diferença para alocado: ${moneyOrUnknown(row.carried)}.`,
        row.available == null ? 'Disponibilidade não informada; percentual não calculado.' : row.available <= 0 ? 'Disponibilidade zero ou negativa; percentual não calculado.' : `Consumo da disponibilidade: ${row.utilization ?? 'não calculado para despesa líquida negativa'}.`
      ].join('\n')),
      listing.total ? 'A diferença para alocado é uma derivação dos saldos, não um valor monetário fornecido pelo campo booleano carryover.' : 'Nenhum orçamento mensal de despesa informado pelo Actual para este período.'
    ].join('\n');
  } else if (kind === 'leaks') {
    body = [
      financialTotals(totals), 'Padrão descritivo — categorias ordenadas pela despesa líquida:', categoryLines(listing.items),
      analysis.byCategory[0]?.gross > 0 ? `A primeira categoria representa ${percentage(analysis.byCategory[0].gross, totals.grossExpenses) ?? 'percentual indisponível'} das despesas brutas.` : '',
      'Hipóteses: esta classificação não determina se um gasto é necessário ou ajustável.',
      'Sugestão: revise os lançamentos das categorias prioritárias antes de definir uma economia; renda recorrente, compromissos e reserva não foram confirmados.'
    ].filter(Boolean).join('\n');
  } else {
    body = [metadata.category ? `Gastos na categoria ${label(metadata.category.name)}${metadata.category.groupId ? ` · grupo ${label(metadata.category.groupId, 128)}` : ` · ID ${label(metadata.category.id, 128)}`}; os totais abaixo usam somente essa categoria.` : '', financialTotals(totals), 'Por categoria\n' + categoryLines(listing.items)].filter(Boolean).join('\n\n');
  }
  const titles = { summary: 'RESUMO FINANCEIRO', spending: 'GASTOS', accounts: 'CONTAS', uncategorized: 'SEM CATEGORIA', budget: 'ORÇAMENTO MENSAL', comparison: 'COMPARAÇÃO DE GASTOS', leaks: 'PRINCIPAIS GASTOS' };
  return [metadata.dataState === 'stale' ? 'DADOS DESATUALIZADOS — Actual indisponível. Valores da última leitura compatível; não confirmam a situação atual.' : '', `${titles[kind]}\n${displayDate(metadata.period.start)} a ${displayDate(metadata.period.end)}`, body, pagination(result), `Fora dos totais\nLançamentos principais de divisões (para evitar duplicidade): ${analysis.excluded.parents}.\nTransferências/pagamentos entre contas: ${analysis.excluded.transfers}.\nMovimentos fora do escopo: ${analysis.excluded.accounts}.`, provenance(metadata)].filter(Boolean).join('\n\n');
}
export function renderScope(scope) {
  return `Escopo financeiro: ${scopeLabel(scope)}.\nOpções: /escopo padrao, /escopo encerradas, /escopo fora_orcamento, /escopo todas.\nA mudança vale para novas consultas; o envelope mensal do Actual mantém seu próprio escopo.`;
}

export function renderInterpretation(metadata) {
  if (metadata.provider !== 'ollama') return '';
  if (metadata.failure) return `Ollama local indisponível: ${ERROR_CODES.has(metadata.failure) ? metadata.failure : 'INTERNAL_ERROR'}. Os comandos financeiros continuam disponíveis.`;
  return `Pergunta interpretada pelo Ollama local (${label(metadata.model ?? 'não informado', 80)}). Valores calculados em código.`;
}
