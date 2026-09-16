import { calendarMonths, normalizeText, resolvePeriod } from '../finance/periods.mjs';
import { validatePeriod } from '../actual/snapshot.mjs';

// A narrow read-only shortcut. Extra conditions and compound requests remain
// with the conversation instead of silently dropping filters or write intents.
export function transactionSearchIntent(input, today) {
  if (typeof input !== 'string' || input.length > 4096) return null;
  let source = normalizeText(input).replace(/[?!.]+$/, '').trim()
    .replace(/\bultimos(?=lancamentos\b)/g, 'ultimos ');
  const suffix = /\s+(?:(?:nos?|dos?|das?|nas?|de|durante|em)\s+)?(semana passada(?: inteira)?|esta semana|semana atual|hoje|ontem|mes passado|este mes|ultimos (?:\d+|seis) meses|ultimos \d+ dias|proximos \d+ meses|\d{4}-\d{2}-\d{2}(?:\s+(?:a |ate )?\d{4}-\d{2}-\d{2})?)$/.exec(source);
  let period;
  if (suffix) {
    source = source.slice(0, suffix.index).trim();
    try {
      const future = /^proximos (\d+) meses$/.exec(suffix[1]);
      if (future) {
        const count = Number(future[1]); if (count < 1 || count > 24) return null;
        const end = new Date(today.slice(0, 7) + '-01T12:00:00Z');
        end.setUTCMonth(end.getUTCMonth() + count);
        const last = new Date(end); last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
        end.setUTCDate(Math.min(Number(today.slice(8)), last.getUTCDate()));
        period = { start: today, end: end.toISOString().slice(0, 10) }; validatePeriod(period);
      } else period = resolvePeriod(suffix[1], today);
    } catch { return null; }
  }
  const list = /^(?:(?:me )?(?:liste|mostre|de)|quais (?:foram|sao)) (?:(?:os meus|os|meus) )?(?:(ultimos|recentes) )?lancamentos$/.exec(source);
  const named = /^(?:procure|pesquise|busque)(?: por)? (?:(?:"([^"]{1,200})"|“([^”]{1,200})”)|([^\s"“”]{1,200}))(?: (?:nos|em) (?:(?:meus|os meus|os) )?lancamentos)?$/.exec(source);
  if (!list && !named) return null;
  const text = named ? named[1] ?? named[2] ?? named[3] : undefined;
  // Generic nouns need context; they are not merchant/notes search terms.
  if (text && /^(?:lancamentos?|compras?|transacoes|isso|isto|eles|elas|tudo|novamente|tambem|agora)$/.test(text)) return null;
  let notice = suffix?.[1].startsWith('semana') || suffix?.[1] === 'esta semana' ? 'A semana é considerada de segunda-feira a domingo.' : '';
  if (!period) {
    period = { ...calendarMonths(12, today) };
    if (named) {
      const end = new Date(today.slice(0, 7) + '-01T12:00:00Z');
      end.setUTCMonth(end.getUTCMonth() + 13); end.setUTCDate(0);
      period.end = end.toISOString().slice(0, 10); validatePeriod(period);
      notice = 'Como você não indicou período, pesquisei os últimos 12 meses-calendário e os próximos 12, incluindo lançamentos futuros já cadastrados.';
    } else notice = 'Consultei os lançamentos mais recentes por data nos últimos 12 meses-calendário, até hoje. Datas futuras ficam fora desta consulta.';
  }
  return { args: { ...period, ...(text ? { text } : {}), page: 1, pageSize: 10 }, notice };
}
