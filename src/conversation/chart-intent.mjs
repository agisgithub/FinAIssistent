import { normalizeText } from '../finance/periods.mjs';

const WORDS = Object.freeze({ um: 1, dois: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, doze: 12 });

export function monthlyChartIntent(input) {
  if (typeof input !== 'string' || input.length > 4096) return null;
  const text = normalizeText(input).replace(/[.!?]+$/g, '').trim();
  if (!/\bgrafico\b/.test(text) || !/\b(?:gastos?|despesas?)\b/.test(text)) return null;
  if (/\b(?:metas?|objetivos?|poupanca|progresso|saldo-alvo|lembre|anote|memorize)\b/.test(text)) return null;
  const duration = /\b(?:nos |dos )?(?:ultimos )?(\d{1,2}|um|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|doze) meses\b/.exec(text);
  if (!duration) return null;
  const months = Number(duration[1]) || WORDS[duration[1]];
  if (!Number.isSafeInteger(months) || months < 1 || months > 24) return null;
  let categoryName = /\bpara (?:a categoria )?(.+)$/.exec(text)?.[1]
    ?? /\bda categoria (.+?)(?=\s+(?:nos |dos )?(?:ultimos )?\S+ meses\b|$)/.exec(text)?.[1]
    ?? /\bcategoria (.+?)(?=\s+(?:nos |dos )?(?:ultimos )?\S+ meses\b|$)/.exec(text)?.[1];
  if (!categoryName) return null;
  categoryName = categoryName.replace(/\s+em (?:barras?|linhas?)$/,'').trim();
  // Compound requests need the model/tool loop so the chart and the second
  // requested operation can both run; never absorb the latter into a category.
  if (/\s+e\s+(?:considere|compare|crie|registre|lembre|atualize|use|avalie)\b/.test(categoryName)) return null;
  if (!categoryName || categoryName.length > 200) return null;
  return { name: 'monthly_spending_series', args: { months, categoryName, chartType: /\b(?:linha|linhas)\b/.test(text) ? 'line' : 'bar' } };
}
