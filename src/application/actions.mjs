import { AppError, errorCode } from '../errors.mjs';
import { OperationJournal, validBackupReference } from '../audit/operations.mjs';
import { featureKey, recommendCategories, validTargetId } from '../categorization/recommend.mjs';
import { withActionMetadata } from '../categorization/response.mjs';
import { transactionFingerprint } from '../actual/transaction.mjs';
import { backupState } from '../backups/encrypted.mjs';
import { localToday } from '../finance/periods.mjs';
import { pageItems } from './queries.mjs';
import { label, parseConfirmation, renderProposal, renderOperation } from '../telegram/confirmations.mjs';

const mutationCommands = new Set(['/categorias','/categorizar','/sugerir','/confirmar','/cancelar','/operacoes','/reconciliar','/desfazer']);
const id = value => { if (!validTargetId(value)) throw new AppError('INPUT_INVALID'); return value; };
const finalOperation = op => ({ ...(op.finalMessage ?? withActionMetadata(renderOperation(op), { reason: 'operation_result', failure: op.error_code })), dedupeKey: `operation-result:${op.id}` });
function pageNumber(args) {
  if (!args.length) return 1;
  const value = args.length === 1 ? args[0] : args.length === 2 && args[0].toLowerCase() === 'pagina' ? args[1] : '';
  if (!/^[1-9]\d{0,5}$/.test(value)) throw new AppError('INPUT_INVALID');
  return Number(value);
}

export class CategorizationActions {
  constructor({ config, store, actual, now = () => new Date(), backupStateImpl = backupState }) {
    Object.assign(this, { config, store, actual, now, backupStateImpl });
    this.journal = new OperationJournal(store);
  }
  checkContext(context) {
    if (context?.householdId !== this.config.householdId || context?.budgetId !== this.config.actual.budgetId) throw new AppError('UNAUTHORIZED');
  }
  checkInspection(inspection, targetId) {
    this.checkContext(inspection?.context);
    const t = inspection.transaction, account = inspection.account;
    if (!t || t.id !== targetId || !account || account.id !== t.accountId || !Array.isArray(inspection.categories) || inspection.fingerprint !== transactionFingerprint(inspection.context, t)) throw new AppError('MUTATION_CONFLICT');
    if (inspection.eligibility?.eligible !== true || account.closed || account.offBudget || t.isParent || t.isChild || t.parentId || t.transferId || t.startingBalance || inspection.payee?.transferAccountId) throw new AppError('MUTATION_INELIGIBLE');
    return inspection;
  }
  destination(inspection, categoryId, allowNull = false) {
    if (categoryId === null && allowNull) return null;
    if (!validTargetId(categoryId) || !inspection.categories.some(c => c.id === categoryId && c.hidden === false)) throw new AppError('MUTATION_CATEGORY_INVALID');
    return categoryId;
  }
  async inspect(targetId) { return this.checkInspection(await this.actual.inspectTransaction(id(targetId)), targetId); }
  async prepare(targetId, categoryId, { identity, job, kind = 'category', undoOf = null, expectedFingerprint = null, originalUncertain = false }) {
    this.store.assertIdentity(identity);
    const replay = this.journal.fromSource(job, identity);
    if (replay) return renderProposal(replay);
    const inspection = await this.inspect(targetId);
    if (expectedFingerprint != null && expectedFingerprint !== inspection.fingerprint) throw new AppError('MUTATION_CONFLICT');
    this.destination(inspection, categoryId, kind === 'undo');
    if (inspection.transaction.categoryId === categoryId) throw new AppError('MUTATION_CONFLICT');
    const before = inspection.transaction, after = { ...before, categoryId };
    const categoryName = value => value === null ? 'sem categoria' : inspection.categories.find(c => c.id === value)?.name ?? `categoria ausente (${value})`;
    const categoryGroup = value => { const c = inspection.categories.find(item => item.id === value); return inspection.categoryGroups?.find(g => g.id === c?.groupId)?.name ?? c?.groupId ?? 'sem grupo'; };
    const p = this.journal.create({ kind, before, after, beforeFingerprint: inspection.fingerprint, afterFingerprint: transactionFingerprint(inspection.context, after),
      display: { accountName: inspection.account.name, payeeName: inspection.payee?.name ?? null, beforeCategory: categoryName(before.categoryId), afterCategory: categoryName(categoryId), beforeGroup: categoryGroup(before.categoryId), afterGroup: categoryGroup(categoryId), originalUncertain },
      reason: { source: kind === 'undo' ? 'undo' : 'explicit', score: null }, expectedCategory: categoryId === null ? null : inspection.categories.find(c => c.id === categoryId), featureKey: featureKey(inspection.context, before), undoOf }, { identity, job, config: this.config });
    return renderProposal(p);
  }
  async confirm(nonce, { identity, job }) {
    const startedAt = performance.now();
    const duration = () => Math.max(0, Math.round(performance.now() - startedAt));
    const { proposal: p, operationId } = this.journal.reserve(nonce, { identity, job, config: this.config });
    let patchRequested = false;
    try {
      const current = await this.inspect(p.target_id);
      if (current.fingerprint !== p.before_fingerprint) throw new AppError('MUTATION_CONFLICT');
      this.destination(current, p.after.categoryId, p.kind === 'undo');
      if (p.expectedCategory && ['id','name','groupId','isIncome','hidden'].some(k => current.categories.find(c => c.id === p.after.categoryId)?.[k] !== p.expectedCategory[k])) throw new AppError('MUTATION_CATEGORY_INVALID');
      if (p.dry_run) return finalOperation(this.journal.finish(operationId, { state: 'simulated', durationMs: duration() }));
      if (!this.config.backup?.keyRef) throw new AppError('BACKUP_FAILED');
      let stateBackupRef;
      try { stateBackupRef = await this.backupStateImpl(this.store, { config: this.config, operationId }); }
      catch { throw new AppError('BACKUP_FAILED'); }
      if (!validBackupReference(stateBackupRef, 'state', operationId)) throw new AppError('BACKUP_FAILED');
      this.journal.executing(operationId, stateBackupRef);
      patchRequested = true;
      const result = await this.actual.changeCategory({ operationId, targetId: p.target_id, expectedFingerprint: p.before_fingerprint, categoryId: p.after.categoryId, expectedCategory: p.expectedCategory, context: { householdId: identity.householdId, budgetId: identity.budgetId } });
      if (!result || !['applied','failed_before','uncertain'].includes(result.status)) throw new AppError('MUTATION_UNCERTAIN');
      if (result.status === 'applied' && (result.code !== null || !result.before || transactionFingerprint(current.context, result.before) !== p.before_fingerprint || result.beforeFingerprint !== p.before_fingerprint || result.afterFingerprint !== p.after_fingerprint || !result.after || transactionFingerprint(current.context, result.after) !== p.after_fingerprint || !Number.isFinite(Date.parse(result.verifiedAt)) || !validBackupReference(result.backupRef, 'actual', operationId))) throw new AppError('MUTATION_UNCERTAIN');
      return finalOperation(this.journal.finish(operationId, { state: result.status, code: result.code ?? null, actualBackupRef: result.backupRef ?? null, durationMs: duration() }));
    } catch (error) {
      // Once the mutation RPC starts, an exception cannot establish non-execution.
      const state = patchRequested ? 'uncertain' : 'failed_before';
      return finalOperation(this.journal.finish(operationId, { state, code: patchRequested ? 'MUTATION_UNCERTAIN' : errorCode(error), durationMs: duration() }));
    }
  }
  async undo(operationId, { identity, job }) {
    this.store.assertIdentity(identity);
    const replay = this.journal.fromSource(job, identity);
    if (replay) return renderProposal(replay);
    const op = this.journal.operation(id(operationId));
    if (!['applied','observed_after'].includes(op.state) || op.dry_run || op.kind !== 'category' || !op.before || !op.after || this.journal.latestTargetOperation(op.target_id)?.id !== op.id) throw new AppError('UNDO_UNAVAILABLE');
    return this.prepare(op.target_id, op.before.categoryId, { identity, job, kind: 'undo', undoOf: op.id, expectedFingerprint: op.after_fingerprint, originalUncertain: op.initial_outcome === 'uncertain' });
  }
  async reconcile(operationId, identity) {
    this.store.assertIdentity(identity);
    const op = this.journal.operation(id(operationId));
    // Reconciliation is a read; an ineligible target is still useful evidence.
    const inspection = await this.actual.inspectTransaction(op.target_id);
    this.checkContext(inspection?.context);
    if (inspection.transaction?.id !== op.target_id || inspection.fingerprint !== transactionFingerprint(inspection.context, inspection.transaction)) throw new AppError('MUTATION_CONFLICT');
    const observed = this.journal.observe(op.id, inspection.fingerprint);
    const text = { observed_before: 'Estado atual igual ao anterior.', observed_after: 'Estado atual igual ao resultado proposto.', diverged: 'Estado atual diferente do anterior e do proposto.' }[observed.reconciliation];
    return { text: `Operação ${op.id}\n${text}\nEsta leitura não comprova quem executou uma alteração. Estado registrado: ${observed.state}; resultado original: ${op.initial_outcome ?? op.state}. Nenhum patch foi repetido.${observed.state === 'observed_after' && observed.kind === 'category' ? `\nPara preparar uma nova proposta de restauração: /desfazer ${op.id}` : ''}` };
  }
  async categories(args) {
    const today = localToday(this.config.timezone, this.now());
    const snapshot = await this.actual.snapshot({ start: today, end: today });
    this.checkContext(snapshot);
    const list = pageItems(snapshot.categories.filter(c => !c.hidden && !snapshot.categoryGroups?.find(g => g.id === c.groupId)?.hidden).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), pageNumber(args));
    const name = c => `${snapshot.categoryGroups?.find(g => g.id === c.groupId)?.name ?? c.groupId ?? 'sem grupo'}/${c.name}`;
    return { text: `Categorias visíveis — página ${list.page}/${list.pages}; ${list.total} itens.\n${list.items.length ? list.items.map(c => `${label(name(c))} — ID: ${c.id}${c.isIncome ? ' (receita)' : ''}`).join('\n') : 'Nenhuma categoria disponível.'}${list.page < list.pages ? `\n/categorias pagina ${list.page + 1}` : ''}` };
  }
  async suggest(targetId, identity) {
    this.store.assertIdentity(identity);
    const inspection = await this.inspect(targetId);
    const rules = this.config.categorization?.rules ?? [], examples = this.journal.examples();
    let options = recommendCategories({ inspection, rules, examples });
    const matchedRule = rules.some(r => r.payeeId === inspection.transaction.payeeId && (!r.accountId || r.accountId === inspection.transaction.accountId));
    const feature = featureKey(inspection.context, inspection.transaction);
    const confirmed = examples.some(e => e.feature_key === feature && e.target_id !== targetId);
    if (!options.length && !matchedRule && !confirmed && feature) {
      const today = localToday(this.config.timezone, this.now()), start = new Date(`${today}T00:00:00Z`);
      start.setUTCFullYear(start.getUTCFullYear() - 1);
      const snapshot = await this.actual.snapshot({ start: start.toISOString().slice(0, 10), end: today });
      this.checkContext(snapshot);
      if (snapshot.coverage?.complete === true) options = recommendCategories({ inspection, rules, examples, history: snapshot.transactions });
    }
    if (!options.length) return { text: `Lançamento ${targetId}: evidência insuficiente ou destino indisponível. Consulte /categorias e escolha explicitamente:\n/categorizar ${targetId} <categoryId>\nNenhuma alteração foi preparada ou executada.` };
    const sourceName = { rule: 'regra explícita local', confirmed: 'exemplos confirmados ativos', history: 'histórico de 12 meses' };
    const groupName = o => { const c = inspection.categories.find(item => item.id === o.categoryId); return inspection.categoryGroups?.find(g => g.id === c.groupId)?.name ?? c.groupId ?? 'sem grupo'; };
    return { text: `Sugestões para ${targetId}. Escore de evidência; não é probabilidade de acerto.\n${options.map((o, index) => `${index + 1}. ${label(o.name)} (grupo ${label(groupName(o))}) — confiança ${o.confidence}, escore ${o.score.toFixed(2)}; ${sourceName[o.source]}; ${o.evidence.count}/${o.evidence.total} evidências${o.evidence.conflict ? '; há conflito' : ''}.\n/categorizar ${targetId} ${o.categoryId}`).join('\n')}\nEscolher uma opção prepara uma proposta. Toda alteração exige confirmação.` };
  }
  async handle(request, job) {
    const startedAt = performance.now(), result = await this.dispatch(request, job);
    if (!result) return null;
    const command = request.type === 'message' ? request.text.trim().split(/\s+/)[0].toLowerCase() : '';
    const reason = command === '/operacoes' ? 'operation_status' : command === '/reconciliar' ? 'operation_reconcile' : 'category_command';
    return withActionMetadata(result, { reason, durationMs: Math.max(0, Math.round(performance.now() - startedAt)) });
  }
  async dispatch(request, job) {
    this.store.assertIdentity(request.identity);
    const tokens = request.type === 'message' ? request.text.trim().split(/\s+/) : [];
    const command = tokens[0]?.toLowerCase(), args = tokens.slice(1);
    if (request.type !== 'callback' && !mutationCommands.has(command)) return null;
    const confirmation = parseConfirmation(request);
    if (confirmation) {
      if (confirmation.action === 'confirm') return this.confirm(confirmation.nonce, { identity: request.identity, job });
      this.journal.cancel(confirmation.nonce, request.identity);
      return { text: 'Proposta cancelada. Nenhuma alteração será executada por essa confirmação.' };
    }
    if (command === '/categorias') return this.categories(args);
    if (command === '/operacoes') {
      if (args.length === 1 && /^[0-9a-f-]{36}$/i.test(args[0])) return renderOperation(this.journal.operation(args[0]));
      const list = pageItems(this.journal.operations(), pageNumber(args));
      return { text: `Operações — página ${list.page}/${list.pages}.\n${list.items.map(op => `${op.id}: ${op.state}${op.error_code ? ` (${op.error_code})` : ''}`).join('\n') || 'Nenhuma operação registrada.'}${list.page < list.pages ? `\n/operacoes pagina ${list.page + 1}` : ''}` };
    }
    if (command === '/sugerir' || (command === '/categorizar' && args.length === 1)) {
      if (args.length !== 1) throw new AppError('INPUT_INVALID');
      return this.suggest(id(args[0]), request.identity);
    }
    if (command === '/categorizar') {
      if (args.length !== 2) throw new AppError('INPUT_INVALID');
      return this.prepare(id(args[0]), id(args[1]), { identity: request.identity, job });
    }
    if (args.length !== 1) throw new AppError('INPUT_INVALID');
    if (command === '/desfazer') return this.undo(id(args[0]), { identity: request.identity, job });
    if (command === '/reconciliar') return this.reconcile(id(args[0]), request.identity);
    throw new AppError('INPUT_INVALID');
  }
}
