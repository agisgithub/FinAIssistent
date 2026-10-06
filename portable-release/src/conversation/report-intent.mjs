import { normalizeText, resolvePeriod } from '../finance/periods.mjs';
import { validatePeriod } from '../actual/snapshot.mjs';
const months=['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
export function reportIntent(value,today) {
  const text=normalizeText(value);
  if(!/\b(?:relatorio|resumo|grafico|gastos|despesas)\b/.test(text))return null;
  if(!/\b(?:macro|por (?:grupo|categoria)|relatorio|resumo|grafico)\b/.test(text))return null;
  // A category-specific chart belongs to the existing monthly-series skill.
  if(/\b(?:para|com|de)\s+(?:a categoria|consumo|mercado|alimentacao)\b/.test(text))return null;
  // Never drop account, merchant, comparison or other requested filters.
  if(/\b(?:conta|bradesco|nubank|compare|comparar|comparacao|versus|favorecido|loja|ifood|somente|apenas)\b/.test(text))return null;
  if(/\b(?:com|para|sobre)\s+(?!(?:um |uma |o |a )?(?:grafico|imagem|grupos?|categorias?)\b)/.test(text))return null;
  if(/\b(?:relatorio|grafico|resumo)\s+(?:de|do|da)\s+(?!(?:gastos?|despesas?|ultimos?|hoje|ontem|mes|como|\d)\b)/.test(text))return null;
  let period;
  const dates=[...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(m=>m[0]);
  const named=new RegExp(`\\b(${months.join('|')})(?:\\s*(?:de|/)\\s*|\\s+)?(20\\d{2}|\\d{2})?\\b`).exec(text);
  const relative=/\b(?:ultimos? \d+ dias|ultimos? \d+ meses|mes passado|esse mes|este mes|mes atual|hoje|ontem)\b/.exec(text)?.[0];
  try {
    if(dates.length===2)period={start:dates[0],end:dates[1]};
    else if(named){const year=named[2]?(named[2].length===2?'20'+named[2]:named[2]):today.slice(0,4),month=months.indexOf(named[1])+1,start=`${year}-${String(month).padStart(2,'0')}-01`;period={start,end:new Date(Date.UTC(Number(year),month,0,12)).toISOString().slice(0,10)};}
    else if(relative)period=resolvePeriod(relative.replace('esse mes','este mes').replace(/^ultimo /,'ultimos '),today);
    else return null;
    validatePeriod(period);
  }catch{return null;}
  return {args:{...period,groupBy:/por categoria(?!s? macro)/.test(text)?'category':'group'},chart:/\bgrafico\b/.test(text)};
}
