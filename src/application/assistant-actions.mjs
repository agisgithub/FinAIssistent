import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError, errorCode, ERROR_CODES } from '../errors.mjs';
import { CategorizationActions } from './actions.mjs';
import { policyHash, PROPOSAL_TTL_MS, validBackupReference } from '../audit/operations.mjs';
import { backupState } from '../backups/encrypted.mjs';
import { validId, transactionFingerprint } from '../actual/transaction.mjs';
import { creationName, checkCreationAvailable, categoryFingerprint } from '../actual/category.mjs';
import { label, displayDate, displayTime } from '../reports/render.mjs';
import { formatMoney } from '../finance/money.mjs';

const json = value => { const text=JSON.stringify(value); if(Buffer.byteLength(text)>262144)throw new AppError('INPUT_INVALID'); return text; };
const hash = value => createHash('sha256').update(json(value)).digest('hex');
const policy = config => hash({version:'assistant-batch-v1',categoryPolicy:policyHash(config)});
const context = identity => ({householdId:identity.householdId,budgetId:identity.budgetId});
const object = (value,allowed,required=allowed) => value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).every(k=>allowed.includes(k)) && required.every(k=>Object.hasOwn(value,k));
export function validateAssistantChanges(input) {
  if(!object(input,['changes','newCategory'],['changes']) || !Array.isArray(input.changes) || input.changes.length>10)throw new AppError('INPUT_INVALID');
  const changes=input.changes.map(row=>{if(!object(row,['transactionId','categoryId'])||!validId(row.transactionId)||!(validId(row.categoryId)||row.categoryId==='$new'))throw new AppError('INPUT_INVALID');return {...row};});
  if(new Set(changes.map(row=>row.transactionId)).size!==changes.length)throw new AppError('INPUT_INVALID');
  let newCategory;
  if(input.newCategory!==undefined){if(!object(input.newCategory,['name','groupId'])||!validId(input.newCategory.groupId))throw new AppError('INPUT_INVALID');newCategory={name:creationName(input.newCategory.name),groupId:input.newCategory.groupId};}
  if((!changes.length&&!newCategory)||(!newCategory&&changes.some(row=>row.categoryId==='$new')))throw new AppError('INPUT_INVALID');
  return {changes,...(newCategory?{newCategory}:{})};
}
function event(store,operationId,event,payload={}) {
  store.db.prepare('INSERT INTO assistant_action_events VALUES(?,?,?,?,?,?)').run(randomUUID(),operationId,store.identity.householdId,event,json(payload),store.now());
}
const initialResult = plan => ({creation:plan.newCategory?{state:'pending',name:plan.newCategory.name,groupId:plan.newCategory.groupId}:null,items:plan.items.map(row=>({transactionId:row.before.id,categoryId:row.categoryId,state:'pending'})),inflight:null});
const decodeProposal = row => row?{...row,plan:row.plan_json?JSON.parse(row.plan_json):null}:null;
function operation(store,id) {
  const row=store.db.prepare('SELECT o.*,p.plan_json,p.dry_run FROM assistant_action_operations o JOIN assistant_action_proposals p ON p.id=o.proposal_id WHERE o.id=? AND o.household_id=? AND o.budget_id=?').get(id,store.identity.householdId,store.identity.budgetId);
  if(!row)throw new AppError('OPERATION_NOT_FOUND');
  return {...row,plan:row.plan_json?JSON.parse(row.plan_json):null,result:row.result_json?JSON.parse(row.result_json):null};
}
const statusNames={pending:'não executado',applied:'aplicado e conferido',failed_before:'não alterado: falha antes da escrita',uncertain:'incerto; não será repetido',simulated:'simulado, sem escrita'};
function renderResult(op) {
  const titles={applied:'Concluído e conferido.',failed_before:'Nenhuma alteração enviada por este lote.',partial:'Concluído parcialmente. As alterações já aplicadas foram mantidas.',uncertain:'Resultado incerto. Não repetirei o lote nem os itens pendentes.',simulated:'SIMULAÇÃO concluída. Nenhuma escrita no Actual.',reserved:'Confirmação reservada; aguarde.',executing:'Em processamento; aguarde.'};
  const result=op.result;
  const lines=[`LOTE ${op.id}`,titles[op.state]??'Estado indisponível.'];
  if(result?.creation)lines.push(`Categoria ${label(result.creation.name)}: ${statusNames[result.creation.state]??'em processamento'}${result.creation.category?.id?` · ID ${result.creation.category.id}`:''}.`);
  if(result)for(const row of result.items)lines.push(`Lançamento ${row.transactionId}: ${statusNames[row.state]??'em processamento'}${row.categoryId&&row.categoryId!=='$new'?` · categoria ${row.categoryId}`:''}.`);
  else lines.push('Detalhes removidos pela retenção.');
  if(op.error_code)lines.push(`Código: ${op.error_code}.`);
  if(['uncertain','partial'].includes(op.state))lines.push('Confira o catálogo e os lançamentos no Actual antes de preparar qualquer nova proposta. Este status não autoriza repetir uma escrita incerta.');
  return {text:lines.join('\n\n'),dedupeKey:`assistant-operation-result:${op.id}`};
}
function enqueueFinal(store,op) {
  const message=renderResult(op);
  store.splitMessage(message.text).forEach((text,index)=>store.enqueueOutbox({text,dedupeKey:`${message.dedupeKey}:${index}`}));
  return message;
}
function renderProposal(p,timezone) {
  if(!p.plan)return {text:'Os detalhes desta proposta expiraram. Prepare uma nova proposta.'};
  if(p.state!=='pending')return {text:`Proposta ${p.id}: ${p.state}. Não será executada novamente.`};
  const plan=p.plan, lines=[p.dry_run?'SIMULAÇÃO — confirmar não altera o Actual.':'ALTERAÇÃO PROPOSTA — exige sua confirmação.'];
  if(plan.newCategory)lines.push(`Criar categoria ${label(plan.newCategory.name)} no grupo ${label(plan.newCategory.expectedGroup.name)} (ID ${plan.newCategory.groupId}); tipo ${plan.newCategory.expectedGroup.isIncome?'receita':'despesa'}.`);
  for(const row of plan.items)lines.push(`${displayDate(row.before.date)} · ${formatMoney(row.before.amount)}\nFavorecido ${label(row.display.payee)} · conta ${label(row.display.account)}\nLançamento ${row.before.id}\nCategoria ${label(row.display.beforeCategory)} → ${label(row.display.afterCategory)}\nGrupo de destino ${label(row.display.afterGroup)} · ID ${row.categoryId==='$new'?'da nova categoria após criação':row.categoryId}`);
  if(plan.items.length)lines.push(`Alterar somente a categoria destes ${plan.items.length} lançamentos. Valores, datas e demais campos serão preservados.`);
  lines.push('O lote pode concluir parcialmente se o servidor falhar. Itens incertos não serão repetidos automaticamente.');
  lines.push(`Válida até ${displayTime(p.expires_at,timezone)} (15 minutos).\n/confirmar_lote ${p.nonce}\n/cancelar_lote ${p.nonce}`);
  return {text:lines.join('\n\n'),replyMarkup:{inline_keyboard:[[{text:p.dry_run?'Confirmar simulação':'Confirmar lote',callback_data:`bf:${p.nonce}`},{text:'Cancelar',callback_data:`bx:${p.nonce}`}]]}};
}

export class AssistantActions {
  constructor({config,store,actual,now=()=>new Date(),backupStateImpl=backupState}) {
    Object.assign(this,{config,store,actual,now,backupStateImpl});
    this.single=new CategorizationActions({config,store,actual,now});
  }
  assertJob(job,identity) { this.single.journal.assertJob(job,identity); }
  proposal(nonce,identity) {
    this.store.assertIdentity(identity);
    const row=this.store.db.prepare('SELECT * FROM assistant_action_proposals WHERE nonce=? AND household_id=? AND budget_id=? AND user_id=? AND chat_id=?').get(nonce,identity.householdId,identity.budgetId,identity.userId,identity.chatId);
    if(!row)throw new AppError('UNAUTHORIZED'); return decodeProposal(row);
  }
  async catalog(identity) {
    const catalog=await this.actual.inspectCategoryCatalog();
    if(catalog?.context?.householdId!==identity.householdId||catalog?.context?.budgetId!==identity.budgetId||!Array.isArray(catalog.categories)||!Array.isArray(catalog.groups))throw new AppError('UNAUTHORIZED');
    return catalog;
  }
  async prepare(input,{identity,job,allowedTransactionIds}) {
    const args=validateAssistantChanges(input); this.assertJob(job,identity);
    const allowed=new Set(allowedTransactionIds??[]);
    if(args.changes.some(row=>!allowed.has(row.transactionId)))throw new AppError('MUTATION_TARGET_MISSING');
    const old=this.store.db.prepare('SELECT * FROM assistant_action_proposals WHERE source_job_id=?').get(job.id);
    if(old){if(old.input_hash!==hash(args))throw new AppError('PROPOSAL_USED');const p=this.proposal(old.nonce,identity);return this.prepared(p);}
    if(this.store.db.prepare('SELECT id FROM proposals WHERE source_job_id=?').get(job.id))throw new AppError('PROPOSAL_USED');
    const plan={items:[],newCategory:null};
    if(args.newCategory){
      const catalog=await this.catalog(identity),group=catalog.groups.find(row=>row.id===args.newCategory.groupId);
      if(!group||group.hidden)throw new AppError('MUTATION_CATEGORY_INVALID');
      plan.newCategory={...args.newCategory,expectedGroup:structuredClone(group)};
      checkCreationAvailable(catalog,plan.newCategory);
    }
    for(const change of args.changes){
      const current=await this.single.inspect(change.transactionId);
      if(change.categoryId!=='$new'){this.single.destination(current,change.categoryId);if(current.transaction.categoryId===change.categoryId)throw new AppError('MUTATION_CONFLICT');}
      const category=change.categoryId==='$new'?null:current.categories.find(row=>row.id===change.categoryId);
      plan.items.push({before:current.transaction,beforeFingerprint:current.fingerprint,categoryId:change.categoryId,expectedCategory:category,
        display:{account:current.account.name,payee:current.payee?.name??'não informado',beforeCategory:current.categories.find(row=>row.id===current.transaction.categoryId)?.name??'sem categoria',afterCategory:category?.name??plan.newCategory.name,afterGroup:category?current.categoryGroups?.find(row=>row.id===category.groupId)?.name??category.groupId:plan.newCategory.expectedGroup.name}});
    }
    const id=randomUUID(),nonce=randomBytes(18).toString('base64url'),now=this.store.now();
    this.store.transaction(()=>{
      this.assertJob(job,identity);
      this.store.db.prepare("INSERT INTO assistant_action_proposals VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,NULL)").run(id,nonce,job.id,identity.householdId,identity.budgetId,identity.userId,identity.chatId,hash(args),policy(this.config),json(plan),this.config.dryRun?1:0,now,now+PROPOSAL_TTL_MS);
      event(this.store,null,'assistant_proposal_created',{proposalId:id,items:plan.items.length,createCategory:!!plan.newCategory});
    });
    return this.prepared(this.proposal(nonce,identity));
  }
  prepared(p) {return {data:{proposalId:p.id,requiresConfirmation:p.state==='pending',state:p.state,changeCount:p.plan?.items.length??0,createsCategory:!!p.plan?.newCategory,dryRun:!!p.dry_run},message:renderProposal(p,this.config.timezone)};}
  validateDestination(current,item,created=null) {
    const expected=item.categoryId==='$new'?created:item.expectedCategory;
    if(!expected)throw new AppError('MUTATION_CATEGORY_INVALID');
    this.single.destination(current,expected.id);
    if(['id','name','groupId','isIncome','hidden'].some(k=>current.categories.find(row=>row.id===expected.id)?.[k]!==expected[k]))throw new AppError('MUTATION_CATEGORY_INVALID');
    return expected;
  }
  async revalidate(plan,identity,{created=null}={}) {
    if(plan.newCategory&&!created)checkCreationAvailable(await this.catalog(identity),plan.newCategory);
    for(const item of plan.items){const current=await this.single.inspect(item.before.id);if(current.fingerprint!==item.beforeFingerprint)throw new AppError('MUTATION_CONFLICT');if(item.categoryId!=='$new'||created)this.validateDestination(current,item,created);}
  }
  saveProgress(id,result){this.store.transaction(()=>{this.store.db.prepare('UPDATE assistant_action_operations SET result_json=?,updated_at=? WHERE id=?').run(json(result),this.store.now(),id);for(const [index,row] of result.items.entries())this.store.db.prepare('UPDATE assistant_action_targets SET state=? WHERE operation_id=? AND target_id=?').run(result.inflight===index?'executing':row.state==='pending'?'reserved':row.state,id,row.transactionId);});}
  finish(id,result,state,code=null) {
    code=code==null?null:ERROR_CODES.has(code)?code:'MUTATION_UNCERTAIN';
    return this.store.transaction(()=>{
      this.store.db.prepare('UPDATE assistant_action_operations SET state=?,result_json=?,error_code=?,updated_at=? WHERE id=?').run(state,json(result),code,this.store.now(),id);
      for(const row of result.items)this.store.db.prepare('UPDATE assistant_action_targets SET state=? WHERE operation_id=? AND target_id=?').run(row.state==='pending'?'failed_before':row.state,id,row.transactionId);
      event(this.store,id,'assistant_operation_'+state,{code}); return enqueueFinal(this.store,operation(this.store,id));
    });
  }
  async confirm(nonce,{identity,job}) {
    let p,id,result;
    this.store.transaction(()=>{
      this.assertJob(job,identity);p=this.proposal(nonce,identity);
      if(p.state!=='pending')throw new AppError('PROPOSAL_USED');
      if(!p.plan||p.expires_at<=this.store.now())throw new AppError('PROPOSAL_EXPIRED');
      if(p.policy_hash!==policy(this.config))throw new AppError('PROPOSAL_POLICY_CHANGED');
      id=randomUUID();result=initialResult(p.plan);
      this.store.db.prepare("UPDATE assistant_action_proposals SET state='approved',consumed_at=? WHERE id=?").run(this.store.now(),p.id);
      this.store.db.prepare("INSERT INTO assistant_action_operations VALUES(?,?,?,?,?,'reserved',?,NULL,NULL,?,?)").run(id,p.id,job.id,identity.householdId,identity.budgetId,json(result),this.store.now(),this.store.now());
      this.store.db.prepare('UPDATE jobs SET safe_retry=0 WHERE id=?').run(job.id);
      for(const item of p.plan.items){
        this.store.db.prepare("INSERT INTO assistant_action_targets VALUES(?,?,'reserved')").run(id,item.before.id);
        if(!p.dry_run){
          this.store.db.prepare("INSERT INTO operation_target_order(household_id,budget_id,target_id,operation_id,operation_kind) VALUES(?,?,?,?,'assistant')").run(identity.householdId,identity.budgetId,item.before.id,id);
          this.store.db.prepare('UPDATE category_examples SET active=0 WHERE household_id=? AND budget_id=? AND target_id=?').run(identity.householdId,identity.budgetId,item.before.id);
        }
      }
      event(this.store,id,'assistant_approval_consumed',{proposalId:p.id});
      this.store.enqueueOutbox({text:`Confirmação recebida. Lote ${id} em processamento${p.dry_run?' (simulação)':''}; aguarde.`,dedupeKey:`assistant-operation-start:${id}`});
    });
    let rpcStarted=false,created=null;
    try {
      await this.revalidate(p.plan,identity);
      if(p.dry_run){if(result.creation)result.creation.state='simulated';result.items.forEach(row=>row.state='simulated');return this.finish(id,result,'simulated');}
      if(!this.config.backup?.keyRef)throw new AppError('BACKUP_FAILED');
      let backup;try{backup=await this.backupStateImpl(this.store,{config:this.config,operationId:id});}catch{throw new AppError('BACKUP_FAILED');}
      if(!validBackupReference(backup,'state',id))throw new AppError('BACKUP_FAILED');
      this.store.db.prepare("UPDATE assistant_action_operations SET state='executing',state_backup_ref=?,updated_at=? WHERE id=?").run(json(backup),this.store.now(),id);
      await this.revalidate(p.plan,identity);
      if(p.plan.newCategory){
        result.inflight='creation';this.saveProgress(id,result);rpcStarted=true;
        const response=await this.actual.createCategory({operationId:id,context:context(identity),...p.plan.newCategory});
        if(!response||!['applied','failed_before','uncertain'].includes(response.status))throw new AppError('MUTATION_UNCERTAIN');
        if(response.backupRef)result.creation.backupRef=response.backupRef;
        if(response.status!=='applied'){result.creation.state=response.status;result.inflight=null;return this.finish(id,result,response.status,response.code??'MUTATION_UNCERTAIN');}
        created=response.category;
        if(response.code!==null||!created||created.name!==p.plan.newCategory.name||created.groupId!==p.plan.newCategory.groupId||created.isIncome!==p.plan.newCategory.expectedGroup.isIncome||created.hidden!==false||response.categoryFingerprint!==categoryFingerprint(context(identity),created)||!Number.isFinite(Date.parse(response.verifiedAt))||!validBackupReference(response.backupRef,'actual',id))throw new AppError('MUTATION_UNCERTAIN');
        result.creation={...result.creation,state:'applied',category:created};result.inflight=null;this.saveProgress(id,result);rpcStarted=false;
      }
      for(let index=0;index<p.plan.items.length;index++){
        const item=p.plan.items[index],current=await this.single.inspect(item.before.id);
        if(current.fingerprint!==item.beforeFingerprint)throw new AppError('MUTATION_CONFLICT');
        const destination=this.validateDestination(current,item,created),afterFingerprint=transactionFingerprint(context(identity),{...item.before,categoryId:destination.id});
        result.items[index].categoryId=destination.id;result.inflight=index;this.saveProgress(id,result);rpcStarted=true;
        const response=await this.actual.changeCategory({operationId:id,targetId:item.before.id,expectedFingerprint:item.beforeFingerprint,categoryId:destination.id,expectedCategory:destination,context:context(identity)});
        if(!response||!['applied','failed_before','uncertain'].includes(response.status))throw new AppError('MUTATION_UNCERTAIN');
        if(response.backupRef)result.items[index].backupRef=response.backupRef;
        if(response.status==='applied'&&(response.code!==null||response.beforeFingerprint!==item.beforeFingerprint||response.afterFingerprint!==afterFingerprint||transactionFingerprint(context(identity),response.before)!==item.beforeFingerprint||transactionFingerprint(context(identity),response.after)!==afterFingerprint||!Number.isFinite(Date.parse(response.verifiedAt))||!validBackupReference(response.backupRef,'actual',id)))throw new AppError('MUTATION_UNCERTAIN');
        result.items[index].state=response.status;result.inflight=null;this.saveProgress(id,result);rpcStarted=false;
        if(response.status!=='applied')return this.finish(id,result,response.status==='uncertain'?'uncertain':this.hasApplied(result)?'partial':'failed_before',response.code??'MUTATION_UNCERTAIN');
      }
      return this.finish(id,result,'applied');
    }catch(error){
      if(rpcStarted){if(result.inflight==='creation')result.creation.state='uncertain';else if(Number.isSafeInteger(result.inflight))result.items[result.inflight].state='uncertain';}
      return this.finish(id,result,rpcStarted?'uncertain':this.hasApplied(result)?'partial':'failed_before',rpcStarted?'MUTATION_UNCERTAIN':errorCode(error));
    }
  }
  hasApplied(result){return result.creation?.state==='applied'||result.items.some(row=>row.state==='applied');}
  async handle(request,job) {
    const parts=request.type==='message'?request.text.trim().split(/\s+/):[],command=parts[0]?.toLowerCase();
    if(request.type==='callback'&&!/^(bf|bx):/.test(request.data))return null;
    if(request.type!=='callback'&&!['/confirmar_lote','/cancelar_lote','/lote'].includes(command))return null;
    this.store.assertIdentity(request.identity);
    if(command==='/lote'){
      if(parts.length===1){const rows=this.store.db.prepare('SELECT id,state,error_code FROM assistant_action_operations WHERE household_id=? AND budget_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10').all(request.identity.householdId,request.identity.budgetId);return {text:'LOTES RECENTES\n\n'+(rows.map(row=>`${row.id}: ${row.state}${row.error_code?` (${row.error_code})`:''}\n/lote ${row.id}`).join('\n\n')||'Nenhum lote registrado.')};}
      if(parts.length!==2||!validId(parts[1]))throw new AppError('INPUT_INVALID');return {text:renderResult(operation(this.store,parts[1])).text};
    }
    const match=request.type==='callback'?/^(bf|bx):([A-Za-z0-9_-]{24})$/.exec(request.data):parts.length===2&&/^[A-Za-z0-9_-]{24}$/.test(parts[1])?[null,command==='/confirmar_lote'?'bf':'bx',parts[1]]:null;
    if(!match)throw new AppError('INPUT_INVALID');
    if(match[1]==='bf')return this.confirm(match[2],{identity:request.identity,job});
    this.store.transaction(()=>{const p=this.proposal(match[2],request.identity);if(p.state!=='pending')throw new AppError('PROPOSAL_USED');this.store.db.prepare("UPDATE assistant_action_proposals SET state='cancelled',consumed_at=? WHERE id=?").run(this.store.now(),p.id);event(this.store,null,'assistant_proposal_cancelled',{proposalId:p.id});});
    return {text:'Proposta cancelada. Nenhuma alteração será executada por esta confirmação.'};
  }
}

export function recoverAssistantActions(store) {
  store.transaction(()=>{
    for(const row of store.db.prepare("SELECT id,result_json FROM assistant_action_operations WHERE state IN ('reserved','executing')").all()){
      const result=JSON.parse(row.result_json);
      if(result.inflight==='creation')result.creation.state='uncertain';else if(Number.isSafeInteger(result.inflight)&&result.items[result.inflight])result.items[result.inflight].state='uncertain';
      store.db.prepare("UPDATE assistant_action_operations SET state='uncertain',result_json=?,error_code='MUTATION_UNCERTAIN',updated_at=? WHERE id=?").run(json(result),store.now(),row.id);
      for(const item of result.items)store.db.prepare('UPDATE assistant_action_targets SET state=? WHERE operation_id=? AND target_id=?').run(item.state==='pending'?'failed_before':item.state,row.id,item.transactionId);
      event(store,row.id,'assistant_restart_uncertain');enqueueFinal(store,operation(store,row.id));
    }
  });
}
export function pruneAssistantActions(store,retentionDays) {
  const cutoff=store.now()-retentionDays*86400000;
  store.transaction(()=>{
    store.db.prepare("UPDATE assistant_action_proposals SET state='expired' WHERE state='pending' AND expires_at<=?").run(store.now());
    store.db.prepare("UPDATE assistant_action_proposals SET plan_json=NULL WHERE created_at<? AND state<>'pending' AND NOT EXISTS(SELECT 1 FROM assistant_action_operations o WHERE o.proposal_id=assistant_action_proposals.id AND o.state IN ('reserved','executing','uncertain','partial'))").run(cutoff);
    store.db.prepare("UPDATE assistant_action_operations SET result_json=NULL WHERE updated_at<? AND state IN ('applied','failed_before','simulated')").run(cutoff);
    store.db.prepare("UPDATE assistant_action_events SET payload=NULL WHERE created_at<?").run(cutoff);
  });
}
