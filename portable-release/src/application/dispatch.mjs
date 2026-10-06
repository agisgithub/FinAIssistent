import { AppError } from '../errors.mjs';
import { normalizeText, resolvePeriod, comparisonPeriods } from '../finance/periods.mjs';
import { validateIntent } from '../llm/contracts.mjs';

export const COMMANDS = Object.freeze({ '/resumo': 'summary', '/gastos': 'spending', '/orcamento': 'budget', '/sem_categoria': 'uncategorized', '/ralos': 'leaks', '/contas': 'accounts', '/comparar': 'comparison' });
export const COMMAND_BY_KIND = Object.freeze(Object.fromEntries(Object.entries(COMMANDS).map(([command, kind]) => [kind, command])));

function spendingArguments(argument, today) {
  if (!argument.toLowerCase().startsWith('com ')) return { period: resolvePeriod(argument, today) };
  const content = argument.slice(4).trim();
  let name, range;
  const quoted = /^("(?:[^"\\]|\\.)*")(?:\s*::\s*([^|]+))?\s*\|\s*(.*)$/.exec(content);
  if (quoted) {
    try { name = JSON.parse(quoted[1]) + (quoted[2] ? ` :: ${quoted[2].trim()}` : ''); } catch { throw new AppError('INPUT_INVALID'); }
    range = quoted[3];
  } else if (content.includes('|')) {
    const parts = content.split('|');
    if (parts.length !== 2) throw new AppError('INPUT_INVALID');
    [name, range] = parts.map(part => part.trim());
  } else {
    const match = /^(.*?)\s+((?:nos )?[uú]ltimos (?:\d+|seis) meses|(?:no |este )?m[eê]s(?: passado| atual)?|hoje|ontem|\d{4}-\d{2}-\d{2}(?:\s+(?:a |at[eé] )?\d{4}-\d{2}-\d{2})?)$/i.exec(content);
    name = match ? match[1] : content; range = match ? match[2] : '';
  }
  if (!name) throw new AppError('INPUT_INVALID');
  return { categoryName: name, period: resolvePeriod(range, today) };
}

// Returns null only for unrecognized natural language. A malformed explicit
// command is rejected instead of being reinterpreted as a different request.
export function parseQuery(text, { today }) {
  if (typeof text !== 'string' || text.length > 4096) throw new AppError('INPUT_INVALID');
  let source = text.trim().replace(/\s+/g, ' ').replace(/[?!.]+$/, '').trim();
  let normalized = normalizeText(source);
  let page = 1;
  const pagination = /(?:^|\s)pagina (\d+)$/.exec(normalized);
  if (pagination) { page = Number(pagination[1]); normalized = normalized.slice(0, pagination.index).trim(); source = source.replace(/\s+p[aá]gina \d+$/i, '').trim(); }
  const [command, ...args] = normalized.split(' ');
  if (command === '/comparar') {
    if (args.length) throw new AppError('INPUT_INVALID');
    return validateIntent({ kind: 'comparison', period: comparisonPeriods(today).period, page }, { today });
  }
  if (COMMANDS[command]) return validateIntent({ kind: COMMANDS[command], ...(command === '/gastos' ? spendingArguments(source.slice(source.indexOf(' ') < 0 ? source.length : source.indexOf(' ') + 1), today) : { period: resolvePeriod(args.join(' '), today) }), page }, { today });
  if (command.startsWith('/')) return null;
  if (/\b(parcelar|financiar|financiamento)\b|\b(?:consigo|posso|cabe|assumir|quero|simule|planejar)\b.{0,100}\b(?:parcelas?|prestacoes|prestacao)\b/.test(normalized)) return validateIntent({ kind: 'needs_info', topic: 'installment' }, { today });
  if (/\b(economizar|poupar|plano de economia|meta de economia|plano de poupanca)\b/.test(normalized)) return validateIntent({ kind: 'needs_info', topic: 'savings' }, { today });
  if (/^(?:quais (?:os )?gastos aumentaram|(?:meus |os )?gastos aumentaram|onde (?:o gasto|os gastos) aument(?:ou|aram)|compare (?:meus |os )?gastos(?: deste mes)?)$/.test(normalized)) return validateIntent({ kind: 'comparison', period: comparisonPeriods(today).period, page }, { today });
  const patterns = [
    [/^(?:quanto (?:(?:eu )?gastei|(?:nos )?gastamos)|quais (?:foram )?(?:os )?meus gastos|mostre (?:meus )?gastos|gastos)(?:\s+(.*))?$/, 'spending'],
    [/^(?:resumo(?: financeiro)?|(?:mostre|quero|me de) (?:um |o |meu )?resumo(?: financeiro)?)(?:\s+(.*))?$/, 'summary'],
    [/^(?:orcamento|como esta (?:o |meu )?orcamento|mostre (?:o |meu )?orcamento)(?:\s+(.*))?$/, 'budget'],
    [/^(?:(?:mostre |quais sao )?(?:as )?(?:transacoes|despesas|compras) sem categoria|sem categoria)(?:\s+(.*))?$/, 'uncategorized'],
    [/^(?:onde (?:eu )?gasto mais|maiores gastos|ralos)(?:\s+(.*))?$/, 'leaks'],
    [/^(?:(?:mostre )?(?:as |minhas )?contas|(?:quais sao )?(?:os )?saldos)(?:\s+(.*))?$/, 'accounts']
  ];
  for (const [pattern, kind] of patterns) {
    const match = pattern.exec(normalized);
    if (!match) continue;
    let range = match[1] ?? '';
    range = range.replace(/^(?:em |de |do |durante )/, '');
    const categoryAt = source.toLowerCase().indexOf(' com ');
    try { return validateIntent({ kind, ...(kind === 'spending' ? spendingArguments(range.startsWith('com ') && categoryAt >= 0 ? source.slice(categoryAt + 1) : range, today) : { period: resolvePeriod(range, today) }), page }, { today }); }
    catch { return null; }
  }
  return null;
}
