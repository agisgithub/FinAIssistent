import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { formatMoney } from '../finance/money.mjs';
import { displayDate, label } from '../reports/render.mjs';
import { CompanionStore } from './store.mjs';

const PROPOSAL_TTL_MS = 15 * 60 * 1000;
const memoryKinds = {
  planned_purchase: 'compra planejada',
  classification_hint: 'pista de classificação',
  financial_note: 'nota financeira'
};
const goalMetrics = {
  manual_savings_progress: 'economia informada manualmente',
  category_spending_cap: 'limite mensal de categoria',
  account_balance: 'saldo-alvo de conta'
};
const goalStatuses = { active: 'ativa', paused: 'pausada', completed: 'concluída', cancelled: 'cancelada' };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const json = value => {
  const result = JSON.stringify(value);
  if (typeof result !== 'string' || Buffer.byteLength(result) > 32768) throw new AppError('INPUT_INVALID');
  return result;
};
const toolOperationKey = request => {
  if (typeof request.toolCallId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(request.toolCallId)) throw new AppError('INPUT_INVALID');
  return `tool:${request.toolCallId}`;
};

function memoryLine(memory) {
  const details = [memory.expectedAmountCents ? formatMoney(memory.expectedAmountCents) : null, memory.plannedOn ? `prevista para ${displayDate(memory.plannedOn)}` : null, `vence em ${displayDate(memory.expiresOn)}`].filter(Boolean).join(' · ');
  return `${memory.id} · ${memoryKinds[memory.kind]}\n${label(memory.subject, 200)}\n${details}`;
}
function goalLine(goal) {
  const progress = goal.metric === 'manual_savings_progress' ? `${formatMoney(goal.currentCents)} de ${formatMoney(goal.targetCents)}` : goal.metric === 'category_spending_cap' ? `${formatMoney(goal.targetCents)}/mês em ${label(goal.categoryName, 160)}` : `${formatMoney(goal.targetCents)} na conta ${label(goal.accountName, 160)}`;
  return `${goal.id} · ${goalStatuses[goal.status]}\n${label(goal.title, 160)} · ${goalMetrics[goal.metric]}\n${progress}${goal.targetOn ? ` · até ${displayDate(goal.targetOn)}` : ''}`;
}
function goalMessage(result) {
  if (result.status === 'not_found') return 'Não encontrei uma meta vigente com esse nome.';
  if (result.status === 'invalid_transition') return `A meta “${label(result.goal.title, 160)}” não aceita essa mudança no estado atual (${goalStatuses[result.goal.status]}).`;
  if (result.status === 'already_exists') return `A meta “${label(result.goal.title, 160)}” já existe e está ${goalStatuses[result.goal.status]}.`;
  const verbs = { created: 'Meta criada', updated: 'Progresso atualizado', paused: 'Meta pausada', active: 'Meta retomada', completed: 'Meta concluída', cancelled: 'Meta cancelada' };
  return `${verbs[result.status] ?? 'Meta atualizada'}: ${label(result.goal.title, 160)}.`;
}
function goalProposalLine(plan) {
  if (plan.action === 'create') {
    const target = plan.metric === 'category_spending_cap' ? `${formatMoney(plan.targetCents)}/mês em ${label(plan.categoryName, 160)}` : plan.metric === 'account_balance' ? `${formatMoney(plan.targetCents)} na conta ${label(plan.accountName, 160)}` : `${formatMoney(plan.currentCents)} de ${formatMoney(plan.targetCents)}`;
    return [`Criar meta: ${label(plan.title, 160)}`, `Métrica: ${goalMetrics[plan.metric]}`, `Alvo: ${target}${plan.targetOn ? ` · até ${displayDate(plan.targetOn)}` : ''}`];
  }
  const actions = { set_progress: 'Definir progresso', add_progress: 'Somar ao progresso', pause: 'Pausar meta', resume: 'Retomar meta', complete: 'Concluir meta', cancel: 'Cancelar meta' };
  const value = plan.action === 'set_progress' ? `: ${formatMoney(plan.currentCents)}` : plan.action === 'add_progress' ? `: ${formatMoney(plan.amountCents)}` : '';
  return [`${actions[plan.action]}: ${label(plan.title, 160)}${value}`];
}
function proposalMessage(operation, plan, nonce) {
  const lines = operation === 'record_memory'
    ? [`Tipo: ${memoryKinds[plan.kind]}`, `Assunto: ${label(plan.subject, 200)}`, ...(plan.note ? [`Nota: ${label(plan.note, 300)}`] : []), ...(plan.merchantPattern ? [`Favorecido: ${label(plan.merchantPattern, 160)}`, `Categoria: ${label(plan.categoryName, 160)}`] : []), ...(plan.expectedAmountCents ? [`Valor previsto: ${formatMoney(plan.expectedAmountCents)}`] : []), ...(plan.plannedOn ? [`Data prevista: ${displayDate(plan.plannedOn)}`] : []), `Validade: ${displayDate(plan.expiresOn)}`]
    : goalProposalLine(plan);
  return {
    text: [`PROPOSTA DO COMPANHEIRO · NADA FOI GRAVADO`, ...lines, '', `Confirme em até 15 minutos: /confirmar_companion ${nonce}`, `Cancelar: /cancelar_companion ${nonce}`].join('\n'),
    replyMarkup: { inline_keyboard: [[{ text: 'Confirmar', callback_data: `pc:${nonce}` }, { text: 'Cancelar', callback_data: `px:${nonce}` }]] }
  };
}

export class CompanionService {
  constructor({ config, store, now = () => new Date() }) {
    this.config = config;
    this.store = store;
    this.repository = new CompanionStore(store, config, { now });
    this.keys = [store.identity.householdId, store.identity.budgetId, store.identity.userId, store.identity.chatId];
  }
  context(identity) {
    this.repository.assert(identity);
    return this.config.companion.enabled ? this.repository.context(identity) : { asOf: this.repository.today(), memories: [], goals: [], truncated: false, disabled: true };
  }
  policyHash() {
    return digest({ version: 'companion-confirmation-1', enabled: this.config.companion.enabled, memoryDefaultTtlDays: this.config.companion.memoryDefaultTtlDays, timezone: this.config.timezone, ttlMs: PROPOSAL_TTL_MS });
  }
  assertJob(job, identity) {
    this.repository.assert(identity);
    const row = this.store.db.prepare("SELECT payload FROM jobs WHERE id=? AND household_id=? AND state='running'").get(job?.id ?? '', identity.householdId);
    if (!row?.payload) throw new AppError('STORAGE_FAILED');
    let payload;
    try { payload = JSON.parse(row.payload); } catch { throw new AppError('STORAGE_FAILED'); }
    this.repository.assert(payload.identity ?? {});
  }
  decodeProposal(row, identity) {
    this.repository.assert(identity);
    if (!row || [row.household_id, row.budget_id, row.user_id, row.chat_id].some((value, index) => value !== this.keys[index])) throw new AppError('UNAUTHORIZED');
    try { return { ...row, plan: row.plan_json == null ? null : JSON.parse(row.plan_json), result: row.result_json == null ? null : JSON.parse(row.result_json) }; }
    catch { throw new AppError('STORAGE_FAILED'); }
  }
  proposal(nonce, identity) {
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(nonce)) throw new AppError('INPUT_INVALID');
    return this.decodeProposal(this.store.db.prepare('SELECT * FROM companion_proposals WHERE nonce=?').get(nonce), identity);
  }
  prepare(operation, plan, request) {
    const operationKey = toolOperationKey(request), inputHash = digest({ operation, plan });
    return this.store.transaction(() => {
      this.assertJob(request.job, request.identity);
      this.store.db.prepare("UPDATE companion_proposals SET state='expired' WHERE state='pending' AND expires_at<=?").run(this.store.now());
      const previous = this.store.db.prepare('SELECT * FROM companion_proposals WHERE source_job_id=? AND operation_key=?').get(request.job.id, operationKey);
      if (previous) {
        const proposal = this.decodeProposal(previous, request.identity);
        if (proposal.operation !== operation || proposal.input_hash !== inputHash) throw new AppError('PROPOSAL_USED');
        return proposal;
      }
      const proposalId = randomUUID(), nonce = randomBytes(18).toString('base64url'), createdAt = this.store.now();
      this.store.db.prepare(`INSERT INTO companion_proposals(id,nonce,source_job_id,operation_key,household_id,budget_id,user_id,chat_id,operation,state,input_hash,policy_hash,plan_json,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)`).run(proposalId, nonce, request.job.id, operationKey, ...this.keys, operation, inputHash, this.policyHash(), json(plan), createdAt, createdAt + PROPOSAL_TTL_MS);
      return this.proposal(nonce, request.identity);
    });
  }
  execute(name, args, request) {
    this.repository.assert(request.identity);
    if (name === 'get_companion_context') {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw new AppError('INPUT_INVALID');
      return { data: { kind: 'companion_context', ...this.context(request.identity) } };
    }
    if (!this.config.companion.enabled) return { data: { kind: 'companion_result', status: 'disabled' }, message: { text: 'O companheiro financeiro está desativado na configuração.' } };
    let operation, plan;
    if (name === 'record_financial_memory') { operation = 'record_memory'; plan = this.repository.validateMemory(args); }
    else if (name === 'manage_financial_goal') { operation = 'manage_goal'; plan = this.repository.validateGoalMutation(args); }
    else throw new AppError('INPUT_INVALID');
    const proposal = this.prepare(operation, plan, request), message = proposalMessage(operation, proposal.plan, proposal.nonce);
    return { data: { kind: 'companion_proposal', status: proposal.state, operation, requiresConfirmation: true }, message };
  }
  confirm(nonce, identity, job) {
    return this.store.transaction(() => {
      this.assertJob(job, identity);
      const proposal = this.proposal(nonce, identity);
      if (proposal.state === 'confirmed' && proposal.confirmation_job_id === job.id && proposal.result) return proposal.result;
      if (proposal.state !== 'pending') throw new AppError(proposal.state === 'expired' ? 'PROPOSAL_EXPIRED' : 'PROPOSAL_USED');
      if (proposal.expires_at <= this.store.now() || !proposal.plan) throw new AppError('PROPOSAL_EXPIRED');
      if (!this.config.companion.enabled || proposal.policy_hash !== this.policyHash()) throw new AppError('PROPOSAL_POLICY_CHANGED');
      let result, message;
      if (proposal.operation === 'record_memory') {
        const plan = this.repository.validateMemory(proposal.plan);
        result = this.repository.recordMemory(plan, identity, job, `proposal:${proposal.id}`);
        message = { text: `Memória registrada: ${label(result.memory.subject, 200)}. Ela fica ativa até ${displayDate(result.memory.expiresOn)}; use /memorias para consultar ou remover.` };
      } else if (proposal.operation === 'manage_goal') {
        const plan = this.repository.validateGoalMutation(proposal.plan);
        result = this.repository.manageGoal(plan, identity, job, `proposal:${proposal.id}`);
        message = { text: goalMessage(result) };
      } else throw new AppError('STORAGE_FAILED');
      this.store.db.prepare("UPDATE companion_proposals SET state='confirmed',consumed_at=?,confirmation_job_id=?,result_json=? WHERE id=? AND state='pending'").run(this.store.now(), job.id, json(message), proposal.id);
      return message;
    });
  }
  cancelProposal(nonce, identity, job) {
    return this.store.transaction(() => {
      this.assertJob(job, identity);
      const proposal = this.proposal(nonce, identity);
      if (proposal.state === 'cancelled' && proposal.confirmation_job_id === job.id && proposal.result) return proposal.result;
      if (proposal.state !== 'pending') throw new AppError(proposal.state === 'expired' ? 'PROPOSAL_EXPIRED' : 'PROPOSAL_USED');
      if (proposal.expires_at <= this.store.now() || !proposal.plan) throw new AppError('PROPOSAL_EXPIRED');
      const message = { text: 'Proposta do companheiro cancelada. Nenhuma memória ou meta foi alterada.' };
      this.store.db.prepare("UPDATE companion_proposals SET state='cancelled',consumed_at=?,confirmation_job_id=?,result_json=? WHERE id=? AND state='pending'").run(this.store.now(), job.id, json(message), proposal.id);
      return message;
    });
  }
  isProposalAction(request) {
    if (request?.type === 'callback') return /^(?:pc|px):/.test(String(request.data ?? ''));
    if (request?.type !== 'message') return false;
    return /^(?:\/confirmar_companion|\/cancelar_companion)(?:\s|$)/i.test(request.text.trim());
  }
  handle(request, job) {
    this.repository.assert(request.identity);
    const callback = request.type === 'callback' ? /^(pc|px):([A-Za-z0-9_-]{24})$/.exec(request.data) : null;
    const parts = request.type === 'message' ? request.text.trim().split(/\s+/) : [];
    const command = parts[0]?.toLowerCase();
    const commandProposal = request.type === 'message' && ['/confirmar_companion','/cancelar_companion'].includes(command)
      ? parts.length === 2 && /^[A-Za-z0-9_-]{24}$/.test(parts[1]) ? [null, command === '/confirmar_companion' ? 'pc' : 'px', parts[1]] : false
      : null;
    if (commandProposal === false) throw new AppError('INPUT_INVALID');
    const proposalAction = callback ?? commandProposal;
    if (proposalAction) return proposalAction[1] === 'pc' ? this.confirm(proposalAction[2], request.identity, job) : this.cancelProposal(proposalAction[2], request.identity, job);
    if (request.type !== 'message') return null;
    if (!this.config.companion.enabled && ['/memorias','/esquecer','/metas','/meta'].includes(command)) return { text: 'O companheiro financeiro está desativado na configuração.' };
    if (command === '/memorias') {
      if (parts.length !== 1) throw new AppError('INPUT_INVALID');
      const rows = this.repository.listMemories(request.identity);
      return { text: rows.length ? ['MEMÓRIAS FINANCEIRAS ATIVAS', ...rows.map(memoryLine), 'Para remover: /esquecer ID'].join('\n\n') : 'Nenhuma memória financeira ativa.' };
    }
    if (command === '/esquecer') {
      if (parts.length !== 2) throw new AppError('INPUT_INVALID');
      const result = this.repository.cancelMemory(parts[1], request.identity, job);
      return { text: result.status === 'cancelled' ? `Memória cancelada e removida do contexto ativo: ${label(result.memory.subject, 200)}. O registro local de auditoria foi preservado.` : result.status === 'not_found' ? 'Memória não encontrada nesta base e conversa.' : `A memória já está ${result.status === 'expired' ? 'expirada' : 'cancelada'}.` };
    }
    if (command === '/metas') {
      if (parts.length !== 1) throw new AppError('INPUT_INVALID');
      const rows = this.repository.listGoals(request.identity);
      return { text: rows.length ? ['METAS FINANCEIRAS', ...rows.map(goalLine), 'Gerencie com /meta pausar|retomar|concluir|cancelar ID.'].join('\n\n') : 'Nenhuma meta financeira cadastrada.' };
    }
    if (command === '/meta') {
      if (parts.length !== 3) return { text: 'Use /meta pausar|retomar|concluir|cancelar ID. Para criar ou atualizar progresso, fale naturalmente com a IA e confirme a proposta.' };
      const actions = { pausar: 'pause', retomar: 'resume', concluir: 'complete', cancelar: 'cancel' };
      if (!Object.hasOwn(actions, parts[1].toLowerCase())) throw new AppError('INPUT_INVALID');
      const result = this.repository.transitionGoalById(parts[2], actions[parts[1].toLowerCase()], request.identity, job);
      return { text: result.status === 'not_found' ? 'Meta não encontrada nesta base e conversa.' : goalMessage(result) };
    }
    return null;
  }
}
