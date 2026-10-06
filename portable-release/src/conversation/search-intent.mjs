import { calendarMonths, normalizeText, resolvePeriod } from '../finance/periods.mjs';
import { validatePeriod } from '../actual/snapshot.mjs';

const counts = { um:1,uma:1,dois:2,duas:2,tres:3,quatro:4,cinco:5,seis:6,sete:7,oito:8,nove:9,dez:10 };
const listPrefix = /^(?:(?:me )?(?:liste|lista|mostre|mostra|de|traga|exiba)|(?:pode|poderia|consegue)(?: me)? (?:listar|mostrar|trazer)|quais (?:foram|sao))\s+/;

// This guard does not infer filters. An unfamiliar listing request may still
// use the model, but it cannot report absence based only on prior conversation.
export function requiresFreshTransactionRead(input) {
  const text = normalizeText(input);
  return (/\b(?:liste|lista|mostre|mostra|listar|mostrar|traga|exiba|busque|procure|pesquise|quais)\b/.test(text) || /^(?:me )?de\b/.test(text))
    && /\b(?:lancamentos?|itens|item|transacoes|movimentacoes|compras?|sem categoria)\b/.test(text)
    && !/\b(?:exemplo|ficticio|ficticia|hipotetico|hipotetica)\b/.test(text);
}

// A narrow read-only shortcut. Extra conditions and compound requests remain
// with the conversation instead of silently dropping filters or write intents.
export function transactionSearchIntent(input, today) {
  if (typeof input !== 'string' || input.length > 4096) return null;
  let source = normalizeText(input).replace(/[?!.]+$/, '').trim()
    .replace(/\bultimos(?=lancamentos\b)/g, 'ultimos ')
    .replace(/^(?:por favor|pfv)[,\s]+/, '')
    .replace(/(?:,?\s+(?:linha a linha|por favor|pfv))+$/, '');
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
  const body = source.replace(listPrefix, '');
  const list = /^(?:(?:todos|todas|os|as|meus|minhas)\s+)*(?:(?:ultimos|ultimas|recentes)\s+)?(?:(\d{1,3}|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\s+)?(?:(?:ultimos|ultimas|mais recentes)\s+)?(itens|lancamentos|transacoes|movimentacoes|gastos)(?:\s+(?:mais recentes|recentes))?(?:\s+(sem categoria))?$/.exec(body);
  const uncategorized = Boolean(list?.[3]) || /^(?:(?:todos|todas|os|as|meus|minhas)\s+)*sem categoria$/.test(body);
  if (list?.[2] === 'gastos' && !uncategorized) return null;
  const count = list?.[1] ? counts[list[1]] ?? Number(list[1]) : 10;
  if (count < 1 || count > 100) return null;
  const named = /^(?:procure|pesquise|busque)(?: por)? (?:(?:"([^"]{1,200})"|“([^”]{1,200})”)|([^\s"“”]{1,200}))(?: (?:nos|em) (?:(?:meus|os meus|os) )?lancamentos)?$/.exec(source);
  if (!list && !named && !uncategorized) return null;
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
  if (count > 10) notice += ` Você pediu ${count} itens; exibo dez por página. Peça “próxima página” para continuar.`;
  return { args: { ...period, ...(text ? { text } : {}), ...(uncategorized ? { uncategorized: true } : {}), page: 1, pageSize: Math.min(count,10) }, notice };
}
