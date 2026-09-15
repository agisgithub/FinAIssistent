import { AppError } from '../errors.mjs';
import { validId } from '../actual/transaction.mjs';
import { validatePeriod } from '../actual/snapshot.mjs';
import { localToday, normalizeText } from '../finance/periods.mjs';
import { DEFAULT_SCOPE, validateScope } from '../finance/analyze.mjs';
import { parseQuery, COMMANDS } from './dispatch.mjs';
import { executeQuery, pageItems } from './queries.mjs';
import { renderQuery } from '../reports/render.mjs';
import { AssistantActions } from './assistant-actions.mjs';

const pageSchema={type:'integer',minimum:1,maximum:100000},sizeSchema={type:'integer',minimum:1,maximum:10};
const idSchema={type:'string',pattern:'^[A-Za-z0-9_-]{1,128}$'};
export const FINANCE_TOOL_DEFINITIONS=Object.freeze([
  {name:'search_transactions',description:'Busca lançamentos existentes no Actual por favorecido/observações; * é curinga. Aceita datas futuras, mas não prevê agendamentos nem calcula saldos. Leia a lista e seus IDs antes de propor alterações.',parameters:{type:'object',additionalProperties:false,required:['start','end'],properties:{text:{type:'string',maxLength:200},start:{type:'string',format:'date'},end:{type:'string',format:'date'},uncategorized:{type:'boolean'},categoryId:idSchema,page:pageSchema,pageSize:sizeSchema}}},
  {name:'list_categories',description:'Busca categorias e grupos reais por trecho de nome, sem distinguir maiúsculas/acentos. text filtra categoria; groupText filtra grupo. Categorias e grupos têm paginação separada (page/groupPage). Use somente destinos visíveis; grupos não podem ser criados.',parameters:{type:'object',additionalProperties:false,properties:{text:{type:'string',maxLength:200},groupText:{type:'string',maxLength:200},page:pageSchema,pageSize:sizeSchema,groupPage:pageSchema}}},
  {name:'query_finances',description:'Executa um comando financeiro de leitura existente: /resumo, /gastos, /orcamento, /sem_categoria, /ralos, /contas ou /comparar. Mantém período histórico, escopo e cálculos determinísticos; não aceita comandos de escrita.',parameters:{type:'object',additionalProperties:false,required:['command'],properties:{command:{type:'string',minLength:1,maxLength:4096}}}},
  {name:'prepare_category_changes',description:'Prepara uma única proposta, nunca executa alterações. Até10 lançamentos já vistos podem receber categorias reais. Para criar categoria em grupo real, inclua newCategory e use categoryId "$new" nos itens desejados; changes vazio cria somente a categoria. A confirmação pertence ao responsável no Telegram.',parameters:{type:'object',additionalProperties:false,required:['changes'],properties:{changes:{type:'array',maxItems:10,items:{type:'object',additionalProperties:false,required:['transactionId','categoryId'],properties:{transactionId:idSchema,categoryId:{type:'string',minLength:1,maxLength:128}}}},newCategory:{type:'object',additionalProperties:false,required:['name','groupId'],properties:{name:{type:'string',minLength:1,maxLength:120},groupId:idSchema}}}}}
]);
function argsObject(value,keys,required=[]) { if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key))||required.some(key=>!Object.hasOwn(value,key)))throw new AppError('INPUT_INVALID'); }
function paging(args){const page=args.page??1,pageSize=args.pageSize??10;if(!Number.isSafeInteger(page)||page<1||page>100000||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>10)throw new AppError('INPUT_INVALID');return {page,pageSize};}
function matcher(pattern='') {
  if(typeof pattern!=='string'||pattern.length>200||/[\u0000-\u001f\u007f-\u009f]/.test(pattern))throw new AppError('INPUT_INVALID');
  const parts=normalizeText(pattern).split('*');if(parts.length>9)throw new AppError('INPUT_INVALID');
  // Literal ordered substring matching: no regex or SQL is built from input.
  return value=>{let offset=0;const text=normalizeText(value);for(const part of parts){if(!part)continue;const index=text.indexOf(part,offset);if(index<0)return false;offset=index+part.length;}return true;};
}
const clipped=(value,max)=>typeof value==='string'?value.slice(0,max):'';
function presentTransaction(row,accounts,categories,payees) {
  const account=accounts.get(row.accountId),payee=payees.get(row.payeeId),category=categories.get(row.categoryId);
  if(!validId(row.id)||!account||!validId(account.id)||!Number.isSafeInteger(row.amount))throw new AppError('SNAPSHOT_INVALID');
  const transfer=!!(row.transferId||payee?.transferAccountId),eligibleForCategoryChange=!(row.isParent||row.isChild||row.parentId||transfer||row.startingBalance||account.closed||account.offBudget||(row.payeeId&&!payee));
  return {id:row.id,date:row.date,amountCents:row.amount,payee:clipped(payee?.name??'não informado',200),notes:clipped(row.notes,500),notesTruncated:(row.notes?.length??0)>500,category:category?{id:category.id,name:clipped(category.name,200),groupId:category.groupId}:null,account:{id:account.id,name:clipped(account.name,200)},isParent:!!row.isParent,isChild:!!row.isChild,transfer,eligibleForCategoryChange};
}

export class FinanceTools {
  constructor({config,store,actual,now=()=>new Date(),actions}){Object.assign(this,{config,store,actual,now});this.actions=actions??new AssistantActions({config,store,actual,now});}
  async execute(name,args,request) {
    this.store.assertIdentity(request.identity);
    if(name==='prepare_category_changes')return this.actions.prepare(args,request);
    if(name==='search_transactions')return this.search(args,request.identity);
    if(name==='list_categories')return this.categories(args,request.identity);
    if(name==='query_finances'){
      argsObject(args,['command'],['command']);if(typeof args.command!=='string'||args.command.length>4096||!Object.hasOwn(COMMANDS,args.command.trim().split(/\s+/)[0].toLowerCase()))throw new AppError('INPUT_INVALID');
      const today=localToday(this.config.timezone,this.now()),intent=parseQuery(args.command,{today});
      if(!intent)throw new AppError('INPUT_INVALID');
      const result=await executeQuery(intent,{config:this.config,store:this.store,actual:this.actual,today});
      const fresh=result.analysis?.metadata.complete===true&&result.analysis.metadata.dataState==='fresh';
      const selection=intent.kind==='uncategorized'?{kind:'transactions',complete:fresh,eligible:fresh,clear:!fresh,dataState:result.analysis?.metadata.dataState??(result.incomplete?'incomplete':'unavailable'),period:intent.period,syncedAt:result.analysis?.metadata.syncedAt??null,page:result.listing?.page??intent.page,pageSize:10,total:result.listing?.total??0,pages:result.listing?.pages??0,transactions:fresh?result.listing.items.map(row=>presentTransaction(row,new Map(result.analysis.accounts.map(a=>[a.id,a])),result.analysis.categories,result.analysis.payees)):[]}:undefined;
      return {data:{kind:'financial_query',text:renderQuery(result),metadata:result.analysis?.metadata??null,complete:!!result.analysis?.metadata.complete,unavailable:!!result.unavailable,incomplete:!!result.incomplete,...(selection?{selection}:{})}};
    }
    throw new AppError('INPUT_INVALID');
  }
  async categories(args,identity) {
    argsObject(args,['text','groupText','page','pageSize','groupPage']);const {page,pageSize}=paging(args),groupPage=paging({page:args.groupPage}).page;
    for(const value of [args.text,args.groupText])if(value!==undefined&&(typeof value!=='string'||value.length>200||/[\u0000-\u001f\u007f-\u009f]/.test(value)))throw new AppError('INPUT_INVALID');
    const catalog=await this.actions.catalog(identity),groups=catalog.groups.filter(row=>!row.hidden&&normalizeText(row.name).includes(normalizeText(args.groupText??''))).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id)),groupMap=new Map(groups.map(row=>[row.id,row]));
    const visible=catalog.categories.filter(row=>!row.hidden&&groupMap.has(row.groupId)&&normalizeText(row.name).includes(normalizeText(args.text??''))).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
    const listing=pageItems(visible,page,pageSize),groupListing=pageItems(groups,groupPage,pageSize);
    return {data:{kind:'categories',complete:true,syncedAt:catalog.syncedAt,page,pageSize,total:listing.total,pages:listing.pages,categories:listing.items.map(row=>({...row,name:clipped(row.name,200),groupName:clipped(groupMap.get(row.groupId).name,200)})),groups:groupListing.items.map(row=>({...row,name:clipped(row.name,200)})),groupPage,totalGroups:groups.length,groupPages:groupListing.pages,groupsTruncated:groups.length>groupListing.items.length,filter:{text:args.text??'',groupText:args.groupText??''}}};
  }
  async search(args,identity) {
    argsObject(args,['text','start','end','uncategorized','categoryId','page','pageSize'],['start','end']);
    const {page,pageSize}=paging(args),period={start:args.start,end:args.end};validatePeriod(period);
    if(args.uncategorized!==undefined&&typeof args.uncategorized!=='boolean'||args.categoryId!==undefined&&!validId(args.categoryId)||args.uncategorized===true&&args.categoryId!==undefined)throw new AppError('INPUT_INVALID');
    const matches=matcher(args.text),snapshot=await this.actual.snapshot(period);
    if(['householdId','budgetId','timezone','currency'].some(key=>snapshot?.[key]!==identity[key]))throw new AppError('UNAUTHORIZED');
    if(snapshot.period?.start!==period.start||snapshot.period?.end!==period.end||snapshot.rulesVersion!=='1'||snapshot.coverage?.complete!==true||snapshot.coverage.failedAccountIds?.length!==0||![snapshot.transactions,snapshot.accounts,snapshot.categories,snapshot.payees].every(Array.isArray))throw new AppError('SNAPSHOT_INVALID');
    const scope=validateScope(this.store.getPreference('finance_scope',DEFAULT_SCOPE)),accounts=new Map(snapshot.accounts.map(row=>[row.id,row])),categories=new Map(snapshot.categories.map(row=>[row.id,row])),payees=new Map(snapshot.payees.map(row=>[row.id,row]));
    if(args.categoryId&&!categories.has(args.categoryId))throw new AppError('MUTATION_CATEGORY_INVALID');
    const rows=snapshot.transactions.filter(row=>{
      const account=accounts.get(row.accountId),payee=payees.get(row.payeeId);
      return account&&(scope.includeClosed||!account.closed)&&(scope.includeOffBudget||!account.offBudget)&&(!args.uncategorized||row.categoryId==null)&&(!args.categoryId||row.categoryId===args.categoryId)&&matches(`${payee?.name??''}\n${row.notes??''}`);
    }).sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
    const listing=pageItems(rows,page,pageSize),transactions=listing.items.map(row=>presentTransaction(row,accounts,categories,payees));
    return {data:{kind:'transactions',complete:true,period,syncedAt:snapshot.syncedAt,scope,page,pageSize,total:listing.total,pages:listing.pages,transactions,notice:'Lançamentos existentes no Actual. Datas futuras não são previsões nem confirmação de pagamento; nenhum saldo ou total histórico foi calculado.'}};
  }
}
