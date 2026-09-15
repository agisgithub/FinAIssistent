import { formatMoney, percentage } from '../finance/money.mjs';
import { COMMAND_BY_KIND } from '../application/dispatch.mjs';

export function label(value, max = 90) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return JSON.stringify(text.length > max ? text.slice(0, max) + '…' : text);
}
const moneyOrUnknown = value => value == null ? 'não informado' : formatMoney(value);
const scopeLabel = scope => `${scope.includeOffBudget ? 'inclui' : 'exclui'} contas fora do orçamento; ${scope.includeClosed ? 'inclui' : 'exclui'} encerradas`;
function provenance(metadata) {
  const accounts = metadata.accountIds.length <= 10 ? metadata.accountIds.map(id => label(id, 128)).join(', ') || 'nenhuma' : `${metadata.accountIds.length} contas; lista em /contas`;
  return [
    `Fonte: Actual. Cobertura da consulta: completa. Dados: ${metadata.dataState === 'stale' ? 'desatualizados' : 'leitura nova'}.`,
    `Snapshot: ${label(metadata.snapshotId, 128)}. Orçamento: ${label(metadata.budgetId, 128)}.`,
    `Período inclusivo: ${metadata.period.start} a ${metadata.period.end}. Fuso: ${label(metadata.timezone)}. Moeda: ${metadata.currency}.`,
    metadata.currentDayPartial ? 'Dia atual em andamento; o mês corrente está parcial.' : 'Período encerrado; alterações retroativas podem mudar uma nova consulta.',
    `Sincronizado: ${label(metadata.syncedAt)}. Regras: ${label(metadata.rulesVersion)}; normalização ${label(metadata.snapshotRulesVersion)}.`,
    `Escopo dos cálculos: ${scopeLabel(metadata.scope)}. Contas incluídas: ${accounts}.`,
    metadata.category ? `Filtro de despesa: categoria ${label(metadata.category.name)}; ID resolvido no catálogo: ${label(metadata.category.id, 128)}.` : 'Categorias: todas no escopo.',
    `Contas excluídas pelo escopo: ${metadata.excludedAccountIds.length}. Ajuste em /escopo.`
  ].join('\n');
}
function pagination(result) {
  const { listing, kind, intent } = result;
  const lines = [`Itens ${listing.first}–${listing.last} de ${listing.total}. Página ${listing.page}/${listing.pages}; ${result.categoryChoice ? 'escolha pendente, sem total calculado' : 'totais usam todos os lançamentos elegíveis'}.`];
  if (listing.page < listing.pages) lines.push(`Próxima: ${COMMAND_BY_KIND[kind]}${kind === 'comparison' ? '' : `${intent.categoryName ? ` com ${JSON.stringify(intent.categoryName)} |` : ''} ${intent.period.start} ${intent.period.end}`} pagina ${listing.page + 1}`);
  return lines.join('\n');
}
function financialTotals(totals) {
  return [
    'Cálculos do período:',
    `Despesas brutas: ${formatMoney(totals.grossExpenses)}.`,
    `Estornos identificados: ${formatMoney(totals.refunds)} (entradas em categorias de despesa).`,
    `Despesas líquidas: ${formatMoney(totals.netExpenses)}.`,
    `Receitas categorizadas: ${formatMoney(totals.income)}; reversões: ${formatMoney(totals.incomeReversals)}; líquidas: ${formatMoney(totals.netIncome)}.`,
    `Entradas sem classificação suficiente: ${formatMoney(totals.unclassifiedInflows)}.`,
    `Movimento líquido elegível: ${formatMoney(totals.netMovement)}.`
  ].join('\n');
}
function categoryLines(items) {
  return items.map(row => `${label(row.name)}: bruto ${formatMoney(row.gross)}, estornos ${formatMoney(row.refunds)}, líquido ${formatMoney(row.net)}; ${row.count} lançamentos.`).join('\n') || 'Nenhum movimento de despesa neste escopo.';
}
export function renderQuery(result) {
  if (result.needsInfo) {
    return result.needsInfo === 'installment' ? 'Para avaliar uma parcela, informe: renda líquida mensal estável, compromissos mensais (incluindo dívidas), reserva disponível, valor da compra, entrada, juros/CET, número de parcelas e prazo. Esses dados ainda não foram confirmados; não foi calculada viabilidade.' : 'Para preparar um plano de economia, informe: renda líquida mensal estável, compromissos mensais, reserva atual, quanto deseja economizar e em qual prazo, além dos gastos que considera ajustáveis. Esses dados ainda não foram confirmados; não foi calculada uma meta viável.';
  }
  if (result.unavailable) return `Actual indisponível para ${result.period.start} a ${result.period.end}. Código: ${result.code}.\nÚltima leitura disponível: ${result.lastSnapshotAt ? label(result.lastSnapshotAt) : 'nenhuma'}. Não há snapshot compatível para apresentar totais deste período e escopo.`;
  if (result.incomplete) return 'Consulta incompleta: uma ou mais contas não puderam ser lidas. Nenhum total completo será apresentado. Tente novamente.';
  if (result.categoryChoice) {
    const groupNames = new Map(result.categoryGroups.map(group => [group.id, group.name]));
    return [
      result.dataState === 'stale' ? 'CATÁLOGO DESATUALIZADO — Actual indisponível.' : '',
      result.categoryChoice === 'ambiguous' ? `Há mais de uma correspondência no catálogo para ${label(result.requestedCategory)}. Qual delas você quer consultar?` : `Não encontrei uma categoria de despesa com o nome exato ${label(result.requestedCategory)}. Escolha um nome do catálogo:`,
      ...result.listing.items.map(category => `${label(category.name)} — grupo ${label(groupNames.get(category.groupId) ?? 'não informado')}${category.groupId ? ` [${label(category.groupId, 128)}]` : ''}${category.hidden ? ' (oculta)' : ''}.\n/gastos com ${JSON.stringify(category.name + (category.groupId ? ` :: ${category.groupId}` : ''))} | ${result.period.start} ${result.period.end}`),
      result.categoryChoice === 'ambiguous' ? 'Se o nome se repetir no mesmo grupo ou uma escolha colidir com um nome que contém " :: ", dê nomes distintos no Actual antes de consultar; não escolherei uma automaticamente.' : '',
      pagination(result),
      `Fonte: catálogo Actual; orçamento ${label(result.budgetId, 128)}; snapshot ${label(result.snapshotId, 128)}; sincronizado ${label(result.syncedAt)}. Nenhum total por categoria foi apresentado.`
    ].filter(Boolean).join('\n');
  }
  const { analysis, listing, kind } = result;
  const { totals, metadata } = analysis;
  let body;
  if (kind === 'comparison') {
    const { ranges, current, previous } = result.comparison;
    body = [
      'Cálculos — comparação mensal de despesas:',
      `Atual: ${ranges.current.start} a ${ranges.current.end} (${ranges.currentDays} dias, último dia em andamento).`,
      `Anterior: ${ranges.previous.start} a ${ranges.previous.end} (${ranges.previousDays} dias encerrados).`,
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
    body = `Fatos do Actual — saldos até ${metadata.period.end}:\n` + (listing.items.map(account => `${label(account.name)} [${label(account.id, 128)}]: ${moneyOrUnknown(account.balance)}; ${account.offBudget ? 'fora do orçamento' : 'no orçamento'}; ${account.closed ? 'encerrada' : 'aberta'}; ${selected.has(account.id) ? 'incluída' : 'excluída'} nos cálculos.`).join('\n') || 'Nenhuma conta.');
  } else if (kind === 'uncategorized') {
    body = `Fatos do Actual — ${analysis.uncategorized.length} lançamentos sem categoria elegíveis:\n` + (listing.items.map(row => `${row.date} | ${formatMoney(row.amount)} | favorecido ${label(analysis.payees.get(row.payeeId)?.name ?? 'não informado')}\nID: ${label(row.id, 128)}${row.parentId ? `; filho de ${label(row.parentId, 128)}; edição somente no Actual` : ''}; conta ${label(row.accountId, 128)}.`).join('\n') || 'Nenhum lançamento sem categoria neste escopo.');
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
    body = [metadata.category ? `Gastos na categoria ${label(metadata.category.name)}; os totais abaixo usam somente essa categoria.` : '', financialTotals(totals), 'Cálculos por categoria:', categoryLines(listing.items)].filter(Boolean).join('\n');
  }
  return [metadata.dataState === 'stale' ? 'DADOS DESATUALIZADOS — Actual indisponível. Valores do último snapshot compatível; não confirmam a situação atual.' : '', body, pagination(result), `Exclusões: ${analysis.excluded.parents} pais de splits, ${analysis.excluded.transfers} movimentos de transferência/pagamento entre contas e ${analysis.excluded.accounts} movimentos fora do escopo.`, provenance(metadata)].filter(Boolean).join('\n\n');
}
export function renderScope(scope) {
  return `Escopo financeiro: ${scopeLabel(scope)}.\nOpções: /escopo padrao, /escopo encerradas, /escopo fora_orcamento, /escopo todas.\nA mudança vale para novas consultas; o envelope mensal do Actual mantém seu próprio escopo.`;
}

export function renderInterpretation(metadata) {
  const duration = Number.isSafeInteger(metadata.durationMs) && metadata.durationMs >= 0 ? `${metadata.durationMs} ms` : 'desconhecido';
  if (metadata.provider === 'deterministic') return `Provedor: regras locais (sem IA). Motivo: comando/pergunta reconhecido. Tempo: ${duration}. Falha: nenhuma. Fallback: não necessário. Uso de IA: nenhum.`;
  const tokens = value => Number.isSafeInteger(value) && value >= 0 ? value : 'desconhecido';
  return `Provedor: Ollama local; modelo ${label(metadata.model ?? 'não configurado', 80)}. Motivo: interpretação de intenção. Tempo: ${duration}. Falha: ${metadata.failure ?? 'nenhuma'}. Fallback: ${metadata.failure ? 'comandos por regras locais disponíveis; nenhum externo acionado' : 'não necessário'}. Tokens entrada/saída/total: ${tokens(metadata.usage?.inputTokens)}/${tokens(metadata.usage?.outputTokens)}/${tokens(metadata.usage?.totalTokens)}. Valores calculados em código.`;
}
