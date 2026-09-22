import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AppError } from '../src/errors.mjs';
import { validateConfig } from '../src/config.mjs';
import { identityFromConfig } from '../src/policy/authorize.mjs';
import { StateStore } from '../src/storage/store.mjs';
import { CompanionStore } from '../src/companion/store.mjs';
import { CompanionService } from '../src/companion/service.mjs';
import { companionMutationIntent, ConversationService, CONVERSATION_SYSTEM } from '../src/conversation/service.mjs';
import { FINANCE_TOOL_DEFINITIONS } from '../src/application/assistant-tools.mjs';
import { createCommandHandler } from '../src/telegram/commands.mjs';
import { inputConfig } from './helpers.mjs';

function fixture(t, companion = {}) {
  let clock = Date.parse('2026-09-20T12:00:00Z');
  const config = validateConfig({ ...inputConfig(), companion });
  const identity = identityFromConfig(config);
  const store = new StateStore(':memory:', identity, { now: () => clock, conversationConfig: config });
  const repository = new CompanionStore(store, config, { now: () => new Date(clock) });
  t.after(() => store.close());
  const request = text => ({ type: 'message', text, identity });
  const job = text => {
    const payload = request(text);
    const id = store.enqueueJob({ kind: 'command', payload, dedupeKey: randomUUID() });
    const claimed = store.claimJob();
    assert.equal(claimed.id, id);
    return { request: payload, job: claimed };
  };
  return { config, identity, store, repository, request, job, setDate: value => { clock = Date.parse(`${value}T12:00:00Z`); } };
}

test('financial memories are scoped, expire, validate closed variants and dedupe per tool call', t => {
  const f = fixture(t, { memoryDefaultTtlDays: 30, maxContextMemories: 1 });
  const firstJob = f.job('vou comprar uma mesa');
  const input = { kind: 'planned_purchase', subject: 'Mesa para o escritório', expectedAmountCents: 120000, plannedOn: '2026-10-01' };
  const first = f.repository.recordMemory(input, f.identity, firstJob.job, 'tool:first');
  const replay = f.repository.recordMemory(input, f.identity, firstJob.job, 'tool:first');
  assert.equal(replay.memory.id, first.memory.id);
  assert.equal(first.memory.expiresOn, '2026-10-31');
  assert.throws(() => f.repository.recordMemory({ ...input, subject: 'Outro item' }, f.identity, firstJob.job, 'tool:first'), { code: 'INPUT_INVALID' });
  const second = f.repository.recordMemory({ kind: 'classification_hint', subject: 'Mercado do bairro é alimentação', merchantPattern: 'Mercado Bairro', categoryName: 'Alimentação', expiresOn: '2026-09-21' }, f.identity, firstJob.job, 'tool:second');
  assert.notEqual(second.memory.id, first.memory.id, 'two distinct calls in one message remain distinct');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM financial_memories').get().n, 2);
  assert.throws(() => f.repository.recordMemory({ kind: 'classification_hint', subject: 'inválida', merchantPattern: 'Loja', categoryName: 'Casa', plannedOn: '2026-10-01' }, f.identity, f.job('x').job), { code: 'INPUT_INVALID' });
  assert.throws(() => f.repository.recordMemory({ kind: 'planned_purchase', subject: 'expira antes', plannedOn: '2026-10-10', expiresOn: '2026-10-09' }, f.identity, f.job('x').job), { code: 'INPUT_INVALID' });
  assert.throws(() => f.repository.listMemories({ ...f.identity, budgetId: 'other' }), { code: 'UNAUTHORIZED' });
  const bounded = f.repository.context(f.identity);
  assert.equal(bounded.memories.length, 1); assert.equal(bounded.truncated, true);
  f.setDate('2026-09-22');
  assert.equal(f.repository.listMemories(f.identity).some(row => row.id === second.memory.id), false);
  assert.equal(f.store.db.prepare('SELECT status FROM financial_memories WHERE id=?').get(second.memory.id).status, 'expired');
});

test('goals use closed cent metrics, explicit lifecycle and idempotent progress receipts', t => {
  const f = fixture(t);
  const created = f.repository.manageGoal({ action: 'create', title: 'Reserva da casa', metric: 'manual_savings_progress', targetCents: 500000, currentCents: 10000, targetOn: '2026-12-31' }, f.identity, f.job('meta').job, 'tool:create');
  assert.equal(created.status, 'created');
  assert.throws(() => f.repository.manageGoal({ action: 'create', title: 'Mercado', metric: 'category_spending_cap', targetCents: 100000 }, f.identity, f.job('meta ruim').job), { code: 'INPUT_INVALID' });
  const progressJob = f.job('guardei mais');
  const progress = { action: 'add_progress', title: 'Reserva da casa', amountCents: 25000 };
  f.repository.manageGoal(progress, f.identity, progressJob.job, 'tool:p1');
  f.repository.manageGoal(progress, f.identity, progressJob.job, 'tool:p1');
  f.repository.manageGoal(progress, f.identity, progressJob.job, 'tool:p2');
  assert.equal(f.repository.listGoals(f.identity)[0].currentCents, 60000, 'same call replays once; distinct call adds once');
  assert.throws(() => f.repository.manageGoal({ ...progress, targetCents: 1 }, f.identity, f.job('campo extra').job), { code: 'INPUT_INVALID' });
  const pause = f.repository.transitionGoalById(created.goal.id, 'pause', f.identity, f.job('/meta pausar').job);
  assert.equal(pause.status, 'paused');
  assert.equal(f.repository.transitionGoalById(created.goal.id, 'resume', f.identity, f.job('/meta retomar').job).status, 'active');
  assert.equal(f.repository.transitionGoalById(created.goal.id, 'complete', f.identity, f.job('/meta concluir').job).status, 'completed');
  assert.equal(f.repository.transitionGoalById(created.goal.id, 'resume', f.identity, f.job('/meta retomar').job).status, 'invalid_transition');
});

test('closed companion tools prepare a visible proposal and persist only after explicit confirmation', async t => {
  const f = fixture(t), seen = [];
  let round = 0;
  const providers = { complete: async input => {
    seen.push(structuredClone(input)); round++;
    if (round === 1) {
      assert.ok(input.tools.some(tool => tool.name === 'record_financial_memory'));
      return { text: '', toolCalls: [{ id: 'memory-call', name: 'record_financial_memory', args: { kind: 'planned_purchase', subject: 'Geladeira', expectedAmountCents: 320000, plannedOn: '2026-10-10' } }] };
    }
    return { text: 'Posso comparar esse valor com sua meta quando você quiser.', toolCalls: [] };
  }, listModels: async () => [] };
  const companion = new CompanionService({ config: f.config, store: f.store, now: () => new Date('2026-09-20T12:00:00Z') });
  const service = new ConversationService({ config: f.config, store: f.store, actual: {}, now: () => new Date('2026-09-20T12:00:00Z'), providers, companionService: companion });
  const queued = f.job('Vou comprar uma Geladeira em 2026-10-10 por R$ 3.200');
  const response = await service.respond(queued.request, queued.job);
  f.store.completeJob(queued.job.id, response);
  assert.match(response.text, /NADA FOI GRAVADO/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM financial_memories').get().n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM companion_proposals WHERE state='pending'").get().n, 1);
  const callback = response.replyMarkup.inline_keyboard[0][0].callback_data;
  const nonce = callback.slice(3), persisted = f.store.db.prepare('SELECT assistant_text,response_json FROM conversation_turns WHERE source_job_id=?').get(queued.job.id);
  assert.match(JSON.parse(persisted.response_json).text, new RegExp(nonce));
  assert.doesNotMatch(persisted.assistant_text, new RegExp(`${nonce}|confirmar_companion|cancelar_companion`));
  const follow = f.job('Explique como essa proposta funciona.');
  const followResponse = await service.respond(follow.request, follow.job); f.store.completeJob(follow.job.id, followResponse);
  assert.doesNotMatch(JSON.stringify(seen[1].messages), new RegExp(`${nonce}|confirmar_companion|cancelar_companion`));
  const confirmation = f.job('/confirmar_companion');
  const confirmed = companion.handle({ type: 'callback', data: callback, identity: f.identity }, confirmation.job);
  assert.match(confirmed.text, /Memória registrada/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM financial_memories').get().n, 1);
  assert.deepEqual(companion.handle({ type: 'callback', data: callback, identity: f.identity }, confirmation.job), confirmed, 'same confirmation job replays the stored result');
  f.store.completeJob(confirmation.job.id, confirmed);
  const memoryId = f.store.db.prepare('SELECT id FROM financial_memories').get().id;
  const handler = createCommandHandler({ config: f.config, store: f.store, actual: {}, companionService: companion, conversationService: service });
  const listing = f.job('/memorias'), listingResponse = await handler(listing.request, listing.job); f.store.completeJob(listing.job.id, listingResponse);
  assert.match(listingResponse.text, new RegExp(memoryId));
  assert.doesNotMatch(f.store.db.prepare('SELECT assistant_text FROM conversation_turns WHERE source_job_id=?').get(listing.job.id).assistant_text, new RegExp(memoryId));
  assert.throws(() => companion.execute('record_financial_memory', { kind: 'financial_note', subject: 'sem correlação' }, { identity: f.identity, job: queued.job }), { code: 'INPUT_INVALID' });
  assert.match(seen[0].messages[0].content, /sem vergonha, culpa/);
  assert.match(CONVERSATION_SYSTEM, /no máximo seis linhas/);
  const manage = FINANCE_TOOL_DEFINITIONS.find(tool => tool.name === 'manage_financial_goal');
  assert.ok(manage); assert.equal(Object.hasOwn(manage.parameters.properties, 'goalId'), false);
  assert.ok(FINANCE_TOOL_DEFINITIONS.some(tool => tool.name === 'get_companion_context'));
});

test('companion confirmation, proposal consumption, conversation and outbox commit atomically', async t => {
  const f = fixture(t), companion = new CompanionService({ config: f.config, store: f.store, now: () => new Date('2026-09-20T12:00:00Z') });
  const source = f.job('Vou comprar uma TV');
  const proposal = companion.execute('record_financial_memory', { kind: 'planned_purchase', subject: 'TV' }, { identity: f.identity, job: source.job, toolCallId: 'atomic-proposal' });
  f.store.completeJob(source.job.id, proposal.message);
  const request = { type: 'callback', callbackId: 'companion-atomic', data: proposal.message.replyMarkup.inline_keyboard[0][0].callback_data, identity: f.identity };
  const jobId = f.store.enqueueJob({ kind: 'command', payload: request, dedupeKey: randomUUID() }), job = f.store.claimJob();
  assert.equal(job.id, jobId);
  const handler = createCommandHandler({ config: f.config, store: f.store, actual: {}, companionService: companion });
  const enqueue = f.store.enqueueOutbox;
  f.store.enqueueOutbox = () => { throw new AppError('STORAGE_FAILED'); };
  await assert.rejects(handler(request, job), { code: 'STORAGE_FAILED' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM financial_memories').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT state FROM companion_proposals').get().state, 'pending');
  assert.equal(f.store.db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id).state, 'running');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM conversation_turns WHERE source_job_id=?').get(job.id).n, 0);
  f.store.enqueueOutbox = enqueue;
  const response = await handler(request, job);
  assert.match(response.text, /Memória registrada/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM financial_memories').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT state FROM companion_proposals').get().state, 'confirmed');
  assert.equal(f.store.db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id).state, 'done');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox WHERE dedupe_key=?').get(`job:${job.id}:0`).n, 1);
});

test('companion mutation intent without an authoritative tool always returns a deterministic no-effect response', async t => {
  const outputs = ['Adicionei a compra.', 'Incluí a nova meta.', 'Defini o progresso.', 'Sua meta agora está ativa.'];
  const f = fixture(t); let index = 0;
  const providers = { complete: async input => ({ text: /^(?:Como|Explique|Quero saber)/i.test(input.messages.at(-1).content) ? 'Uma conversa comum continua normalmente.' : outputs[index++ % outputs.length], toolCalls: [] }), listModels: async () => [] };
  const service = new ConversationService({ config: f.config, store: f.store, actual: {}, providers });
  for (const text of ['Salve esta informação financeira.', 'Adicione uma nota financeira.', 'Pode salvar esta informação financeira?', 'Anote esta compra.', 'Crie uma meta Reserva.', 'Atualize o progresso da meta Reserva.', 'Retome minha meta Reserva.']) {
    const queued = f.job(text), response = await service.respond(queued.request, queued.job); f.store.completeJob(queued.job.id, response);
    assert.match(response.text, /Nada foi gravado ou alterado/);
    assert.doesNotMatch(response.text, /Adicionei|Incluí|Defini|agora está ativa/i);
  }
  for (const text of ['Como classificar uma compra?', 'Explique como criar uma meta.', 'Quero saber como guardar uma informação.']) {
    const common = f.job(text), commonResponse = await service.respond(common.request, common.job); f.store.completeJob(common.job.id, commonResponse);
    assert.match(commonResponse.text, /conversa comum continua normalmente/i);
    assert.doesNotMatch(commonResponse.text, /Nada foi gravado ou alterado/);
  }
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM financial_memories').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM financial_goals').get().n, 0);
});

test('closed companion mutation grammar separates explicit writes from educational and Actual requests', () => {
  const mutations = [
    ['Salve esta informação financeira', 'record_financial_memory'],
    ['Pode salvar esta informação financeira?', 'record_financial_memory'],
    ['Adicione uma nota financeira', 'record_financial_memory'],
    ['Por favor, adicionar uma memória financeira', 'record_financial_memory'],
    ['Inclua esta compra nas memórias', 'record_financial_memory'],
    ['Incluir o progresso da meta Reserva', 'manage_financial_goal'],
    ['Registre esta nota financeira', 'record_financial_memory'],
    ['Registrar meu objetivo Reserva', 'manage_financial_goal'],
    ['Anote esta compra', 'record_financial_memory'],
    ['Anotar esta informação financeira', 'record_financial_memory'],
    ['Memorize esta informação financeira', 'record_financial_memory'],
    ['Memorizar uma nota financeira', 'record_financial_memory'],
    ['Lembre desta compra', 'record_financial_memory'],
    ['Lembrar esta informação financeira', 'record_financial_memory'],
    ['Guarde esta informação financeira', 'record_financial_memory'],
    ['Guardar uma nota financeira', 'record_financial_memory'],
    ['Crie uma meta Reserva', 'manage_financial_goal'],
    ['Criar uma memória financeira', 'record_financial_memory'],
    ['Defina meu objetivo Reserva', 'manage_financial_goal'],
    ['Definir uma nota financeira', 'record_financial_memory'],
    ['Atualize o progresso da meta Reserva', 'manage_financial_goal'],
    ['Pause a meta Reserva', 'manage_financial_goal'],
    ['Retome meu objetivo Reserva', 'manage_financial_goal'],
    ['Conclua a meta Reserva', 'manage_financial_goal'],
    ['Cancele meu objetivo Reserva', 'manage_financial_goal'],
    ['Salva esta informação', 'record_financial_memory'],
    ['Anota isto', 'record_financial_memory'],
    ['Registra uma nota', 'record_financial_memory'],
    ['Cria uma meta', 'manage_financial_goal'],
    ['Acrescente uma regra', 'record_financial_memory'],
    ['Coloque esta compra', 'record_financial_memory'],
    ['Quero que você salve isso', 'record_financial_memory'],
    ['Atualizamos o progresso da meta', 'manage_financial_goal'],
    ['Pausaria minha meta', 'manage_financial_goal'],
    ['Retomaremos o objetivo', 'manage_financial_goal'],
    ['Concluí minha meta', 'manage_financial_goal'],
    ['Cancelei meu objetivo', 'manage_financial_goal'],
    ['Encerra esta meta', 'manage_financial_goal'],
    ['Salve o modelo de TV como informação', 'record_financial_memory'],
    ['Anote esta explicação como nota', 'record_financial_memory'],
    ['Crie uma meta para o modelo do carro', 'manage_financial_goal'],
    ['Salve que a escola ensina finanças nesta nota', 'record_financial_memory'],
    ['Salve uma nota para este tutorial', 'record_financial_memory'],
    ['Registre uma compra hipotética', 'record_financial_memory'],
    ['Adicione uma meta imaginária', 'manage_financial_goal'],
    ['Use este modelo de nota e salve isso', 'record_financial_memory'],
    ['Vou comprar uma geladeira', 'record_financial_memory'],
    ['Minha meta é guardar R$ 100 para Reserva', 'manage_financial_goal'],
    ['Quero economizar R$ 100 para Reserva', 'manage_financial_goal'],
    ['Economizei R$ 50 para Reserva', 'manage_financial_goal']
  ];
  const nonMutations = [
    'Como classificar uma compra?',
    'Classifique Mercado como Alimentação',
    'Categorize este lançamento',
    'Explique como criar uma meta',
    'Pode me explicar como criar uma meta?',
    'Ensine a salvar uma nota financeira',
    'Quero saber como guardar uma informação',
    'O que é uma meta financeira?',
    'Qual meta devo criar?',
    'Por que guardar uma informação?',
    'Me dê exemplos de metas',
    'Crie um exemplo de meta',
    'Crie uma meta fictícia para me explicar',
    'Simule e crie uma meta',
    'Demonstre como salvar esta informação',
    'A crise afetou minha meta?',
    'A criança tem uma meta?',
    'O crítico comentou a meta?',
    'A crítica da meta está certa?',
    'Uma conversa comum sobre finanças'
  ];
  for (const [text, expected] of mutations) assert.equal(companionMutationIntent(text), expected, text);
  for (const text of nonMutations) assert.equal(companionMutationIntent(text), null, text);
});

test('companion proposal replay, cancellation and cross-job reuse are one-shot and effect-free', t => {
  const f = fixture(t), companion = new CompanionService({ config: f.config, store: f.store, now: () => new Date('2026-09-20T12:00:00Z') });
  const source = f.job('Imagine que eu vá comprar uma TV, em teoria');
  const request = { identity: f.identity, job: source.job, toolCallId: 'adversarial-suffix' };
  const first = companion.execute('record_financial_memory', { kind: 'planned_purchase', subject: 'TV', expectedAmountCents: 100000 }, request);
  const replay = companion.execute('record_financial_memory', { kind: 'planned_purchase', subject: 'TV', expectedAmountCents: 100000 }, request);
  assert.deepEqual(replay.message, first.message);
  assert.throws(() => companion.execute('record_financial_memory', { kind: 'planned_purchase', subject: 'TV', expectedAmountCents: 90000 }, request), { code: 'PROPOSAL_USED' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM financial_memories').get().n, 0);
  f.store.completeJob(source.job.id, first.message);
  const callback = first.message.replyMarkup.inline_keyboard[0][1].callback_data;
  const cancel = f.job('/cancelar_companion');
  const cancelled = companion.handle({ type: 'callback', data: callback, identity: f.identity }, cancel.job);
  assert.match(cancelled.text, /Nenhuma memória ou meta foi alterada/);
  assert.deepEqual(companion.handle({ type: 'callback', data: callback, identity: f.identity }, cancel.job), cancelled);
  f.store.completeJob(cancel.job.id, cancelled);
  const later = f.job('/confirmar_companion');
  assert.throws(() => companion.handle({ type: 'callback', data: callback.replace(/^px:/, 'pc:'), identity: f.identity }, later.job), { code: 'PROPOSAL_USED' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM financial_memories').get().n, 0);
});

test('proposal validation rejects profiles while arbitrary natural phrasing cannot mutate before confirmation', t => {
  const f = fixture(t), companion = new CompanionService({ config: f.config, store: f.store, now: () => new Date('2026-09-20T12:00:00Z') });
  const execute = (name, text, args, humanText = text) => {
    const queued = f.job(text);
    try { return companion.execute(name, args, { identity: f.identity, job: queued.job, toolCallId: randomUUID(), humanText }); }
    finally { f.store.completeJob(queued.job.id, { text: 'fim' }); }
  };
  assert.throws(() => execute('record_financial_memory', 'Anote esta compra', { kind: 'financial_note', subject: 'Geladeira', evidence: 'Anote esta compra' }), { code: 'INPUT_INVALID' });
  assert.throws(() => execute('record_financial_memory', 'Perfil psicológico: comprador compulsivo', { kind: 'financial_note', subject: 'Perfil psicológico: comprador compulsivo', evidence: 'Perfil psicológico: comprador compulsivo' }), { code: 'INPUT_INVALID' });
  assert.throws(() => execute('record_financial_memory', 'PERFIL PSICOLÓGICO: comprador com\u202Epulsivo', { kind: 'financial_note', subject: 'PERFIL PSICOLÓGICO: comprador com\u202Epulsivo', evidence: 'PERFIL PSICOLÓGICO: comprador com\u202Epulsivo' }), { code: 'INPUT_INVALID' });
  assert.throws(() => execute('manage_financial_goal', 'Não crie uma meta Reserva de R$ 100', { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000, evidence: 'Não crie uma meta Reserva de R$ 100' }), { code: 'INPUT_INVALID' });
  assert.throws(() => execute('record_financial_memory', 'Anote Viagem', { kind: 'financial_note', subject: 'Carro', evidence: 'Anote Carro' }, 'Anote Carro'), { code: 'INPUT_INVALID' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM financial_memories').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM financial_goals').get().n, 0);
  const accepted = execute('record_financial_memory', 'Anote: reserva para revisão do carro', { kind: 'financial_note', subject: 'reserva para revisão do carro' });
  assert.equal(accepted.data.status, 'pending');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM financial_memories').get().n, 0);
});

test('questions, hypotheses, quotes and suffixes can only become pending proposals with no effect', t => {
  const f = fixture(t), companion = new CompanionService({ config: f.config, store: f.store, now: () => new Date('2026-09-20T12:00:00Z') });
  const execute = ({ name, text, args }) => {
    const queued = f.job(text);
    const shape = structuredClone(args); delete shape.evidence;
    try { return companion.execute(name, shape, { identity: f.identity, job: queued.job, toolCallId: randomUUID(), humanText: text }); }
    finally { f.store.completeJob(queued.job.id, { text: 'fim' }); }
  };
  const positives = [
    { name: 'record_financial_memory', text: 'Vou comprar Geladeira por R$ 3.200', args: { kind: 'planned_purchase', subject: 'Geladeira', expectedAmountCents: 320000, evidence: 'Vou comprar Geladeira por R$ 3.200' } },
    { name: 'record_financial_memory', text: 'Classifique Mercado Bairro como Alimentação', args: { kind: 'classification_hint', subject: 'Mercado Bairro como Alimentação', merchantPattern: 'Mercado Bairro', categoryName: 'Alimentação', evidence: 'Classifique Mercado Bairro como Alimentação' } },
    { name: 'record_financial_memory', text: 'Anote esta nota financeira: priorizar a reserva', args: { kind: 'financial_note', subject: 'priorizar a reserva', evidence: 'Anote esta nota financeira: priorizar a reserva' } },
    { name: 'manage_financial_goal', text: 'Minha meta é guardar R$ 100 para Reserva', args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000, evidence: 'Minha meta é guardar R$ 100 para Reserva' } },
    { name: 'manage_financial_goal', text: 'Quero economizar R$ 200 para Viagem', args: { action: 'create', title: 'Viagem', metric: 'manual_savings_progress', targetCents: 20000, evidence: 'Quero economizar R$ 200 para Viagem' } },
    { name: 'manage_financial_goal', text: 'Minha meta Mercado mensal é limitar Alimentação a R$ 500 por mês', args: { action: 'create', title: 'Mercado mensal', metric: 'category_spending_cap', targetCents: 50000, categoryName: 'Alimentação', evidence: 'Minha meta Mercado mensal é limitar Alimentação a R$ 500 por mês' } },
    { name: 'manage_financial_goal', text: 'Minha meta Reserva mínima é atingir R$ 1.000 na conta Corrente', args: { action: 'create', title: 'Reserva mínima', metric: 'account_balance', targetCents: 100000, accountName: 'Corrente', evidence: 'Minha meta Reserva mínima é atingir R$ 1.000 na conta Corrente' } },
    { name: 'manage_financial_goal', text: 'Quero pausar minha meta Reserva', args: { action: 'pause', title: 'Reserva', evidence: 'Quero pausar minha meta Reserva' } },
    { name: 'manage_financial_goal', text: 'Quero retomar minha meta Reserva', args: { action: 'resume', title: 'Reserva', evidence: 'Quero retomar minha meta Reserva' } },
    { name: 'manage_financial_goal', text: 'Economizei R$ 25 para Reserva', args: { action: 'add_progress', title: 'Reserva', amountCents: 2500, evidence: 'Economizei R$ 25 para Reserva' } },
    { name: 'manage_financial_goal', text: 'Atualize o progresso da meta Reserva para R$ 50', args: { action: 'set_progress', title: 'Reserva', currentCents: 5000, evidence: 'Atualize o progresso da meta Reserva para R$ 50' } },
    { name: 'manage_financial_goal', text: 'Quero concluir minha meta Reserva', args: { action: 'complete', title: 'Reserva', evidence: 'Quero concluir minha meta Reserva' } },
    { name: 'manage_financial_goal', text: 'Quero cancelar minha meta Viagem', args: { action: 'cancel', title: 'Viagem', evidence: 'Quero cancelar minha meta Viagem' } }
  ];
  for (const row of positives) assert.equal(execute(row).data.status, 'pending', row.text);
  const baseline = {
    memories: f.store.db.prepare('SELECT COUNT(*) n FROM financial_memories').get().n,
    goals: f.store.db.prepare('SELECT COUNT(*) n FROM financial_goals').get().n
  };
  const negatives = [
    { name: 'record_financial_memory', text: 'Será que sou um comprador patológico?', args: { kind: 'financial_note', subject: 'comprador patológico', evidence: 'Será que sou um comprador patológico?' } },
    { name: 'manage_financial_goal', text: 'Minha meta não é guardar R$ 100 para Reserva', args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000, evidence: 'Minha meta não é guardar R$ 100 para Reserva' } },
    { name: 'record_financial_memory', text: 'Vou comprar TV por R$ 1.000?', args: { kind: 'planned_purchase', subject: 'TV', expectedAmountCents: 100000, evidence: 'Vou comprar TV por R$ 1.000?' } },
    { name: 'manage_financial_goal', text: 'Você acha que minha meta é guardar R$ 100 para Reserva', args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000, evidence: 'Você acha que minha meta é guardar R$ 100 para Reserva' } },
    { name: 'manage_financial_goal', text: 'Você poderia registrar que minha meta é guardar R$ 100 para Reserva', args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000, evidence: 'Você poderia registrar que minha meta é guardar R$ 100 para Reserva' } },
    { name: 'record_financial_memory', text: 'Se eu comprar TV por R$ 1.000, anote TV', args: { kind: 'planned_purchase', subject: 'TV', expectedAmountCents: 100000, evidence: 'Se eu comprar TV por R$ 1.000, anote TV' } },
    { name: 'manage_financial_goal', text: 'Ela disse: “Minha meta é guardar R$ 100 para Reserva”', args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000, evidence: 'Ela disse: “Minha meta é guardar R$ 100 para Reserva”' } },
    { name: 'manage_financial_goal', text: 'Fulano disse: minha meta é guardar R$ 100 para Reserva', args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000, evidence: 'Fulano disse: minha meta é guardar R$ 100 para Reserva' } },
    { name: 'manage_financial_goal', text: "'Minha meta é guardar R$ 100 para Reserva'", args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000, evidence: "'Minha meta é guardar R$ 100 para Reserva'" } },
    { name: 'manage_financial_goal', text: 'Não é que eu não queira guardar R$ 100; minha meta é Reserva', args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000, evidence: 'Não é que eu não queira guardar R$ 100; minha meta é Reserva' } },
    { name: 'manage_financial_goal', text: 'Minha meta é guardar R$ 100 sem compromisso para Reserva', args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000, evidence: 'Minha meta é guardar R$ 100 sem compromisso para Reserva' } },
    { name: 'record_financial_memory', text: 'Geladeira R$ 3.200', args: { kind: 'planned_purchase', subject: 'Geladeira', expectedAmountCents: 320000, evidence: 'Geladeira R$ 3.200' } },
    { name: 'record_financial_memory', text: 'Anote: gosto de azul', args: { kind: 'financial_note', subject: 'gosto de azul', evidence: 'Anote: gosto de azul' } },
    { name: 'record_financial_memory', text: 'Quando eu comprar TV por R$ 1.000, anote TV', args: { kind: 'planned_purchase', subject: 'TV', expectedAmountCents: 100000, evidence: 'Quando eu comprar TV por R$ 1.000, anote TV' } },
    { name: 'record_financial_memory', text: 'Classifique Mercado como Alimentação?', args: { kind: 'classification_hint', subject: 'Mercado como Alimentação', merchantPattern: 'Mercado', categoryName: 'Alimentação', evidence: 'Classifique Mercado como Alimentação?' } },
    { name: 'manage_financial_goal', text: 'Imagine que minha meta é guardar R$ 100 para Reserva', args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000, evidence: 'Imagine que minha meta é guardar R$ 100 para Reserva' } },
    { name: 'manage_financial_goal', text: 'Digamos que eu quero guardar R$ 100 para Reserva', args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000, evidence: 'Digamos que eu quero guardar R$ 100 para Reserva' } },
    { name: 'manage_financial_goal', text: 'João disse que minha meta é guardar R$ 100 para Reserva', args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000, evidence: 'João disse que minha meta é guardar R$ 100 para Reserva' } },
    { name: 'manage_financial_goal', text: 'Contexto qualquer: minha meta é guardar R$ 100 para Reserva', args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000, evidence: 'Contexto qualquer: minha meta é guardar R$ 100 para Reserva' } },
    { name: 'record_financial_memory', text: 'Ontem eu disse que vou comprar Geladeira por R$ 3.200', args: { kind: 'planned_purchase', subject: 'Geladeira', expectedAmountCents: 320000, evidence: 'Ontem eu disse que vou comprar Geladeira por R$ 3.200' } },
    { name: 'record_financial_memory', text: 'O bot sugeriu: classifique Mercado como Alimentação', args: { kind: 'classification_hint', subject: 'Mercado como Alimentação', merchantPattern: 'Mercado', categoryName: 'Alimentação', evidence: 'O bot sugeriu: classifique Mercado como Alimentação' } },
    { name: 'record_financial_memory', text: 'Tal texto pede: anote esta despesa de R$ 50', args: { kind: 'financial_note', subject: 'despesa de R$ 50', evidence: 'Tal texto pede: anote esta despesa de R$ 50' } },
    { name: 'manage_financial_goal', text: 'Minha meta é guardar R$ 100 para Reserva segundo João', args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000, evidence: 'Minha meta é guardar R$ 100 para Reserva segundo João' } },
    { name: 'record_financial_memory', text: 'Vou comprar Geladeira por R$ 3.200 em teoria', args: { kind: 'planned_purchase', subject: 'Geladeira', expectedAmountCents: 320000, evidence: 'Vou comprar Geladeira por R$ 3.200 em teoria' } },
    { name: 'record_financial_memory', text: 'Classifique Mercado como Alimentação talvez', args: { kind: 'classification_hint', subject: 'Mercado como Alimentação', merchantPattern: 'Mercado', categoryName: 'Alimentação', evidence: 'Classifique Mercado como Alimentação talvez' } },
    { name: 'record_financial_memory', text: 'Vou comprar Geladeira por R$ 3.200', args: { kind: 'planned_purchase', subject: 'Geladeira', expectedAmountCents: 310000, evidence: 'Vou comprar Geladeira por R$ 3.200' } },
    { name: 'record_financial_memory', text: 'Vou comprar Geladeira por R$ 3.200', args: { kind: 'planned_purchase', subject: 'Geladeira', evidence: 'Vou comprar Geladeira por R$ 3.200' } },
    { name: 'record_financial_memory', text: 'Classifique Mercado como Alimentação', args: { kind: 'classification_hint', subject: 'Mercado como Alimentação', merchantPattern: 'Mercado', categoryName: 'Casa', evidence: 'Classifique Mercado como Alimentação' } },
    { name: 'record_financial_memory', text: 'Classifique Mercado como Alimentação', args: { kind: 'classification_hint', subject: 'Mercado como Alimentação', categoryName: 'Alimentação', evidence: 'Classifique Mercado como Alimentação' } },
    { name: 'manage_financial_goal', text: 'Minha meta é guardar R$ 100 para Reserva', args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', evidence: 'Minha meta é guardar R$ 100 para Reserva' } },
    { name: 'manage_financial_goal', text: 'Minha meta é guardar R$ 100 para Reserva', args: { action: 'create', title: 'Viagem', metric: 'manual_savings_progress', targetCents: 10000, evidence: 'Minha meta é guardar R$ 100 para Reserva' } },
    { name: 'manage_financial_goal', text: 'Minha meta é guardar R$ 100 para Reserva', args: { action: 'create', title: 'Reserva', metric: 'account_balance', targetCents: 10000, accountName: 'Corrente', evidence: 'Minha meta é guardar R$ 100 para Reserva' } },
    { name: 'manage_financial_goal', text: 'Minha meta é guardar R$ 100 para Reserva', args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000, evidence: 'Minha meta é guardar R$ 100' } }
  ];
  for (const row of negatives) {
    const invalidShape = /patológico/i.test(row.args.subject ?? '') || row.args.kind === 'classification_hint' && !row.args.merchantPattern || row.args.action === 'create' && row.args.targetCents == null;
    if (invalidShape) assert.throws(() => execute(row), { code: 'INPUT_INVALID' }, row.text);
    else assert.equal(execute(row).data.status, 'pending', row.text);
  }
  assert.deepEqual({ memories: f.store.db.prepare('SELECT COUNT(*) n FROM financial_memories').get().n, goals: f.store.db.prepare('SELECT COUNT(*) n FROM financial_goals').get().n }, baseline);
});

test('repository rejects profile labels in every persisted free-text position', t => {
  const f = fixture(t), first = f.job('direto');
  try {
    assert.throws(() => f.repository.recordMemory({ kind: 'classification_hint', subject: 'Regra', merchantPattern: 'Loja', categoryName: 'Perfil psicológico' }, f.identity, first.job), { code: 'INPUT_INVALID' });
    assert.throws(() => f.repository.recordMemory({ kind: 'financial_note', subject: 'comprador patológico' }, f.identity, first.job), { code: 'INPUT_INVALID' });
  } finally { f.store.completeJob(first.job.id, { text: 'fim' }); }
  const second = f.job('direto 2');
  try {
    assert.throws(() => f.repository.createGoal({ title: 'Saldo', metric: 'account_balance', targetCents: 10000, accountName: 'Comprador compulsivo' }, f.identity, second.job), { code: 'INPUT_INVALID' });
  } finally { f.store.completeJob(second.job.id, { text: 'fim' }); }
});

test('tool portfolio composes categorization and chart capabilities with companion goals', async t => {
  const f = fixture(t), calls = [];
  const providers = { complete: async input => { calls.push(structuredClone(input)); return { text: 'Certo.', toolCalls: [] }; }, listModels: async () => [] };
  const service = new ConversationService({ config: f.config, store: f.store, actual: {}, now: () => new Date('2026-09-20T12:00:00Z'), providers });
  const first = f.job('Adicione uma nota financeira sobre como categorizar o lançamento selecionado');
  const firstResponse = await service.respond(first.request, first.job); f.store.completeJob(first.job.id, firstResponse);
  const categoryNames = new Set(calls[0].tools.map(tool => tool.name));
  for (const name of ['search_transactions','list_categories','prepare_category_changes','record_financial_memory']) assert.ok(categoryNames.has(name), name);
  const second = f.job('Crie uma meta de economia e mostre o gráfico dos últimos 6 meses para Consumo');
  const secondResponse = await service.respond(second.request, second.job); f.store.completeJob(second.job.id, secondResponse);
  const graphNames = new Set(calls[1].tools.map(tool => tool.name));
  assert.ok(graphNames.has('monthly_spending_series')); assert.ok(graphNames.has('manage_financial_goal'));
  for (const text of ['Classifique Mercado como Alimentação', 'Classifiquem Mercado como Alimentação', 'Quero classificar Mercado como Alimentação']) {
    const queued = f.job(text), response = await service.respond(queued.request, queued.job); f.store.completeJob(queued.job.id, response);
    const actualNames = new Set(calls.at(-1).tools.map(tool => tool.name));
    for (const name of ['search_transactions','list_categories','prepare_category_changes']) assert.ok(actualNames.has(name), `${text}: ${name}`);
    assert.equal(actualNames.has('record_financial_memory'), false);
  }
});

test('Telegram memory and goal commands remain deterministic and scoped to the bound identity', async t => {
  const f = fixture(t), companion = new CompanionService({ config: f.config, store: f.store, now: () => new Date('2026-09-20T12:00:00Z') });
  const memoryJob = f.job('criar memória');
  const memory = f.repository.recordMemory({ kind: 'financial_note', subject: 'Priorizar a reserva antes de compras grandes' }, f.identity, memoryJob.job);
  f.store.completeJob(memoryJob.job.id);
  const goalJob = f.job('criar meta');
  const goal = f.repository.createGoal({ title: 'Reserva', metric: 'manual_savings_progress', targetCents: 100000 }, f.identity, goalJob.job);
  f.store.completeJob(goalJob.job.id);
  const handler = createCommandHandler({ config: f.config, store: f.store, actual: {}, companionService: companion, intentClient: { interpret: async () => assert.fail('model must not run') } });
  const send = async text => {
    const queued = f.job(text), response = await handler(queued.request, queued.job);
    f.store.completeJob(queued.job.id, response); return response;
  };
  assert.match((await send('/memorias')).text, new RegExp(memory.memory.id));
  assert.match((await send(`/esquecer ${memory.memory.id}`)).text, /contexto ativo/);
  assert.match((await send('/metas')).text, new RegExp(goal.goal.id));
  assert.match((await send(`/meta pausar ${goal.goal.id}`)).text, /pausada/);
  assert.match((await send(`/meta retomar ${goal.goal.id}`)).text, /retomada/);
  assert.match((await send(`/meta concluir ${goal.goal.id}`)).text, /concluída/);
});

test('companion configuration has bounded diagnostics and old configs keep defaults', () => {
  const defaults = validateConfig(inputConfig()).companion;
  assert.deepEqual(defaults, { enabled: true, transactionMonitorEnabled: false, autoCategorizeHighConfidence: false, memoryDefaultTtlDays: 180, maxContextMemories: 12, maxContextGoals: 8, maxContextChars: 4000 });
  assert.equal(validateConfig({ ...inputConfig(), companion: { transactionMonitorEnabled: true } }).companion.transactionMonitorEnabled, true);
  assert.throws(() => validateConfig({ ...inputConfig(), companion: { autoCategorizeHighConfidence: true } }), { code: 'CONFIG_INVALID' });
  const real = validateConfig({ ...inputConfig(), dryRun: false, backup: { keyRef: 'backup-key' }, companion: { transactionMonitorEnabled: true, autoCategorizeHighConfidence: true } });
  assert.equal(real.companion.autoCategorizeHighConfidence, true);
  assert.throws(() => validateConfig({ ...inputConfig(), companion: { maxContextGoals: 0 } }), { code: 'CONFIG_INVALID' });
  assert.throws(() => validateConfig({ ...inputConfig(), companion: { unknown: true } }), { code: 'CONFIG_INVALID' });
});
