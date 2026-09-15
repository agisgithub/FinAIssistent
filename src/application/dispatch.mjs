import { AppError } from '../errors.mjs';
import { normalizeText, resolvePeriod } from '../finance/periods.mjs';
import { validateIntent } from '../llm/contracts.mjs';

export const COMMANDS = Object.freeze({ '/resumo': 'summary', '/gastos': 'spending', '/orcamento': 'budget', '/sem_categoria': 'uncategorized', '/ralos': 'leaks', '/contas': 'accounts' });
export const COMMAND_BY_KIND = Object.freeze(Object.fromEntries(Object.entries(COMMANDS).map(([command, kind]) => [kind, command])));

// Returns null only for unrecognized natural language. A malformed explicit
// command is rejected instead of being reinterpreted as a different request.
export function parseQuery(text, { today }) {
  if (typeof text !== 'string' || text.length > 4096) throw new AppError('INPUT_INVALID');
  let normalized = normalizeText(text).replace(/[?!.]+$/, '').trim();
  let page = 1;
  const pagination = /(?:^|\s)pagina (\d+)$/.exec(normalized);
  if (pagination) { page = Number(pagination[1]); normalized = normalized.slice(0, pagination.index).trim(); }
  const [command, ...args] = normalized.split(' ');
  if (COMMANDS[command]) return validateIntent({ kind: COMMANDS[command], period: resolvePeriod(args.join(' '), today), page }, { today });
  if (command.startsWith('/')) return null;
  const patterns = [
    [/^(?:quanto (?:eu )?gastei|quais (?:foram )?(?:os )?meus gastos|mostre (?:meus )?gastos|gastos)(?:\s+(.*))?$/, 'spending'],
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
    try { return validateIntent({ kind, period: resolvePeriod(range, today), page }, { today }); }
    catch { return null; }
  }
  return null;
}
