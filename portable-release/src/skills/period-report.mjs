import { AppError } from '../errors.mjs';
import { validatePeriod } from '../actual/snapshot.mjs';
import { analyzeSnapshot, validateScope } from '../finance/analyze.mjs';
import { localToday } from '../finance/periods.mjs';
import { add, formatMoney } from '../finance/money.mjs';
import { displayDate, safeLabel } from '../reports/render.mjs';

// Closing an account stops its current use; it must not erase historical income
// or expenses. Keep the legacy query scope unchanged and honor explicit choices.
export const DEFAULT_REPORT_SCOPE = Object.freeze({includeOffBudget:false,includeClosed:true});

export async function periodReport(args, {config,store,actual,now}) {
  if (!args || Object.keys(args).some(k=>!['start','end','groupBy'].includes(k)) || !['group','category'].includes(args.groupBy??'group')) throw new AppError('INPUT_INVALID');
  const period={start:args.start,end:args.end}; validatePeriod(period);
  const snapshot=await actual.snapshot(period),today=localToday(config.timezone,now());
  const {data}=periodReportSnapshot(args,{config,store,snapshot,today});
  return {data,message:{text:reportText(data)}};
}

// One source of accounting semantics for Telegram reports and the live dashboard.
export function periodReportSnapshot(args,{config,store,snapshot,today}) {
  const period={start:args.start,end:args.end};validatePeriod(period);
  if(snapshot.householdId!==config.householdId || snapshot.budgetId!==config.actual.budgetId || snapshot.currency!==config.currency || snapshot.timezone!==config.timezone) throw new AppError('UNAUTHORIZED');
  if(snapshot.coverage?.complete!==true || !Array.isArray(snapshot.transactions)) throw new AppError('SNAPSHOT_INVALID');
  const opening=snapshot.transactions.filter(row=>row.startingBalance), openingIds=new Set(opening.map(row=>row.id));
  const options={period,today,allowFuture:true,scope:validateScope(store.getPreference('finance_scope',DEFAULT_REPORT_SCOPE))};
  const movement=analyzeSnapshot({...snapshot,transactions:snapshot.transactions.filter(row=>!openingIds.has(row.id)&&!openingIds.has(row.parentId))},options);
  const policy=store.getPreference('financial_report_policy',null);
  if(policy&&(policy.version!==1||policy.budgetId!==config.actual.budgetId||!Array.isArray(policy.technicalCategoryIds)||policy.technicalCategoryIds.some(id=>typeof id!=='string')))throw new AppError('UNAUTHORIZED');
  const technicalIds=new Set(policy?.technicalCategoryIds??[]);
  const technicalRows=movement.includedTransactions.filter(row=>technicalIds.has(row.categoryId));
  const technical={count:technicalRows.length,inflowCents:0,outflowCents:0};
  for(const row of technicalRows){if(row.amount>0)technical.inflowCents=add(technical.inflowCents,row.amount);else technical.outflowCents=add(technical.outflowCents,-row.amount);}
  const analysis=technicalIds.size?analyzeSnapshot({...snapshot,transactions:snapshot.transactions.filter(row=>!openingIds.has(row.id)&&!openingIds.has(row.parentId)&&!technicalIds.has(row.categoryId))},options):movement;
  const groupBy=args.groupBy??'group', groups=new Map((snapshot.categoryGroups??[]).map(g=>[g.id,g.name])),aggregates=new Map();
  for(const category of analysis.byCategory) {
    const details=analysis.categories.get(category.id), groupId=details?.groupId;
    const key=groupBy==='category'?category.id:groupId??'uncategorized';
    const row=aggregates.get(key)??{name:groupBy==='category'?category.name:(groups.get(groupId)??(category.id?'Grupo não identificado':'Sem categoria')),grossCents:0,refundCents:0,netCents:0,count:0};
    row.grossCents=add(row.grossCents,category.gross);row.refundCents=add(row.refundCents,category.refunds);row.netCents=add(row.netCents,category.net);row.count+=category.count;aggregates.set(key,row);
  }
  const rows=[...aggregates.values()].sort((a,b)=>b.netCents-a.netCents||a.name.localeCompare(b.name));
  let inflowCents=0,outflowCents=0;
  for(const row of movement.includedTransactions) { if(row.amount>0)inflowCents=add(inflowCents,row.amount);else outflowCents=add(outflowCents,-row.amount); }
  const data={kind:'period_report',complete:true,period,groupBy,currency:config.currency,syncedAt:snapshot.syncedAt,future:period.end>today,scope:analysis.metadata.scope,totals:{...analysis.totals,inflowCents,outflowCents},technical,excluded:{...analysis.excluded,openingBalances:opening.length},rows};
  return {data,analysis,movement,technicalIds};
}

export function reportText(data) {
  return [
    `GASTOS POR ${data.groupBy==='group'?'GRUPO':'CATEGORIA'} · ${displayDate(data.period.start)} a ${displayDate(data.period.end)}`,
    `Entradas registradas: ${formatMoney(data.totals.inflowCents)} · Saídas registradas: ${formatMoney(data.totals.outflowCents)}`,
    `Gastos líquidos (saídas de despesas − estornos): ${formatMoney(data.totals.netExpenses)}`,
    ...data.rows.map(row=>`• ${safeLabel(row.name,80)}: ${formatMoney(row.netCents)}`),
    ...(data.technical?.count?[`Separado do gasto pessoal: ${data.technical.count} movimentos técnicos; entradas ${formatMoney(data.technical.inflowCents)}, saídas ${formatMoney(data.technical.outflowCents)}. Não são renda nem estorno de consumo.`]:[]),
    ...(data.rows.length?[]:['Não há despesas registradas neste período e escopo.']),
    'Sem transferências vinculadas, pais de divisões e saldos iniciais. Cartão conta pela data do lançamento, não pelo pagamento da fatura. Valores são movimentos registrados, não saldo bancário.',
    data.scope.includeClosed?'Inclui o histórico de contas encerradas.':'Atenção: sua preferência exclui contas encerradas; receitas e despesas antigas podem ficar fora deste relatório.',
    ...(data.future?['Período futuro: somente lançamentos já existentes; não comprova pagamentos nem prevê novas despesas.']:[])
  ].join('\n');
}
