import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { testConfig, tempDirectory } from './helpers.mjs';
import { financialSnapshot, TODAY } from './fixtures/financial.mjs';
import { StateStore } from '../src/storage/store.mjs';
import { identityFromConfig } from '../src/policy/authorize.mjs';
import { ConversationStore } from '../src/conversation/store.mjs';
import { ConversationService } from '../src/conversation/service.mjs';
import { createCommandHandler } from '../src/telegram/commands.mjs';
import { AppError } from '../src/errors.mjs';
import { ChatProviders } from '../src/llm/chat.mjs';

const answer = (text = 'Olá! Posso consultar seu orçamento.', toolCalls = []) => ({ text, toolCalls, assistantMessage: { role: 'assistant', content: text, toolCalls }, usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } });
const call = (name, args, id = 'tool-1') => ({ id, name, args });
const transaction = (id = 'tx-A') => ({ id, date: TODAY, amountCents: -12345, payee: 'Brastemp fictícia', notes: 'Parcela sintética', account: { id: 'checking', name: 'Conta fictícia' }, category: null, eligibleForCategoryChange: true });
const search = (rows = [transaction()], total = rows.length) => ({ data: { kind: 'transactions', complete: true, period: { start: '2026-09-01', end: '2027-04-30' }, syncedAt: TODAY + 'T12:00:00Z', total, pages: Math.max(1, Math.ceil(total / 10)), transactions: rows } });
function fixture(t, { assistant = {}, disk = false, tools, providers: overrides = {} } = {}) {
  let clock = Date.parse(TODAY + 'T12:00:00Z'), sequence = 0;
  let store;
  t.after(() => { try { store?.close(); } catch {} });
  const directory = disk ? tempDirectory(t) : process.cwd();
  const base = testConfig(directory), config = { ...base, ollama: { ...base.ollama, enabled: true, model: 'fixture-local', localOnlyConfirmed: true }, privacy: { externalProviders: true }, gemini: { enabled: true, model: 'fixture-remote' }, assistant: { enabled: true, historyTtlMinutes: 1440, maxTurns: 12, maxToolRounds: 4, maxToolCalls: 8, maxContextChars: 24000, maxToolResultChars: 8000, ...assistant } };
  const identity = identityFromConfig(config), filename = disk ? path.join(directory, 'state.sqlite') : ':memory:';
  store = new StateStore(filename, identity, { now: () => clock, conversationConfig: config });
  const requests = [], executions = [];
  const providers = { complete: async input => { requests.push(structuredClone(input)); return overrides.complete ? overrides.complete(input) : answer(); }, listModels: overrides.listModels ?? (async ({ provider }) => [{ id: provider === 'ollama' ? 'fixture-local' : 'fixture-remote' }]) };
  const financeTools = { execute: async (name, args, context) => { executions.push({ name, args: structuredClone(args), allowed: [...context.allowedTransactionIds] }); return tools ? tools(name, args, context) : search(); } };
  const actual = { snapshot: async period => {
    const snapshot = financialSnapshot(period), sample = snapshot.transactions.find(row => row.id === 'uncategorized');
    snapshot.transactions.push({ ...sample, id: 'extra-1' }, { ...sample, id: 'extra-2' }); return snapshot;
  } };
  let service, handler;
  const wire = () => {
    service = new ConversationService({ config, store, actual, now: () => new Date(clock), providers, financeTools });
    handler = createCommandHandler({ config, store, actual, now: () => new Date(clock), conversationService: service, assistantActions: { handle: async request => request.data === 'bf:synthetic' ? { text: 'Resultado incerto. Nenhuma repetição automática.', metadata: { failure: 'MUTATION_UNCERTAIN' } } : null } });
  };
  wire();
  return { config, identity, actual, requests, executions, get store() { return store; }, get service() { return service; },
    at(value) { clock = value; }, advance(ms) { clock += ms; },
    async send(text, { callback = false, finish = true } = {}) {
      const request = callback ? { type: 'callback', data: text, callbackId: 'callback', identity } : { type: 'message', text, identity };
      store.enqueueJob({ kind: 'command', payload: request, dedupeKey: `conversation-test:${++sequence}` });
      const job = store.claimJob(), response = await handler(request, job);
      if (finish) store.completeJob(job.id, response);
      return { response, request, job };
    },
    invoke(request, job) { return handler(request, job); },
    restart() { store.close(); store = new StateStore(filename, identity, { now: () => clock, conversationConfig: config }); store.recover(); wire(); }
  };
}

test('natural greeting and follow-up use local conversation, with durable final turns and no native provider frames exported', async t => {
  const f = fixture(t, { disk: true, providers: { complete: async () => ({ ...answer('Olá, vamos conversar.'), assistantMessage: { role: 'assistant', content: 'Olá', providerContent: { provider: 'ollama', secretNative: 'NATIVE_CANARY' } } }) } });
  await f.send('oi'); f.restart(); await f.send('o que você pode fazer?');
  assert.equal(f.requests.length, 2); assert.equal(f.requests[0].provider, 'ollama');
  assert.ok(f.requests[1].messages.some(row => row.role === 'user' && row.content === 'oi'));
  assert.ok(f.requests[1].messages.some(row => row.role === 'assistant' && /Olá/.test(row.content)));
  assert.doesNotMatch(JSON.stringify(f.requests[1].messages), /NATIVE_CANARY|providerContent|toolCalls/);
  assert.equal(f.executions.length, 0);
});

test('abbreviated selection fields retain explicit limits in the tool result and subsequent context', async t => {
  let round = 0;
  const rows = [{ ...transaction(), payee: 'p'.repeat(180), notes: 'n'.repeat(300), account: { id: 'checking', name: 'a'.repeat(120) }, category: { id: 'food', name: 'c'.repeat(120), groupId: 'expenses' } }, { ...transaction('tx-B'), notes: 'Trecho já reduzido na fonte.', notesTruncated: true }];
  const f = fixture(t, { tools: async () => search(rows), providers: { complete: async () => ++round === 1 ? answer('', [call('search_transactions', { start: TODAY, end: TODAY })]) : answer('Confira os trechos.') } });
  const result = await f.send('busque as compras');
  const data = JSON.parse(f.requests[1].messages.find(row => row.role === 'tool').content);
  assert.equal(data.truncated, false); assert.equal(data.textTruncated, true);
  assert.deepEqual(data.transactions[0].textTruncatedFields, ['payee', 'notes', 'account.name', 'category.name']);
  assert.equal(data.transactions[0].notes.length, 200); assert.equal(data.transactions[1].notesTruncated, true);
  assert.match(data.textNotice, /não representam a descrição completa/); assert.match(result.response.text, /observações abreviados/);
  await f.send('são da mesma compra?');
  const context = f.requests.at(-1).messages.find(row => row.content?.startsWith('DADOS OBSERVADOS'));
  assert.match(context.content, /textTruncatedFields/); assert.match(context.content, /não representam a descrição completa/);
});

test('a selected Gemini disabled in configuration never falls through to the legacy Ollama interpreter', async t => {
  for (const setting of ['enabled', 'externalProviders']) {
    const f = fixture(t);
    const consent = (await f.send('/ia gemini')).response;
    await f.send(consent.replyMarkup.inline_keyboard[0][0].callback_data, { callback: true });
    if (setting === 'enabled') f.config.gemini.enabled = false; else f.config.privacy.externalProviders = false;
    const response = (await f.send('resuma os gastos deste mês')).response;
    assert.match(response.text, /Gemini está indisponível/); assert.match(response.text, /\/ia ollama/);
    assert.equal(f.requests.length, 0); assert.equal(f.executions.length, 0); assert.equal(f.service.repository.session().provider, 'gemini');
  }
});

test('slash uncategorized listing seeds numeric references; one proposal stops the model loop and preserves exact buttons', async t => {
  const proposal = { text: 'PROPOSTA AUTORITATIVA — apenas simulação.', replyMarkup: { inline_keyboard: [[{ text: 'Confirmar', callback_data: 'bf:opaque' }]] }, dedupeKey: 'proposal:one' };
  const f = fixture(t, { providers: { complete: async () => answer('Já alterei tudo!', [call('prepare_category_changes', { changes: [{ transactionId: '1', categoryId: 'food' }, { transactionId: '3', categoryId: 'food' }] })]) }, tools: async () => ({ data: { kind: 'proposal' }, message: proposal }) });
  await f.send('/sem_categoria'); const selected = f.service.repository.selection(); assert.ok(selected.rows.length >= 3);
  const result = await f.send('categorize 1 e3');
  assert.equal(f.requests.length, 1); assert.deepEqual(f.executions[0].args.changes.map(row => row.transactionId), [selected.rows[0].id, selected.rows[2].id]);
  assert.deepEqual(result.response.replyMarkup, proposal.replyMarkup); assert.equal(result.response.text, proposal.text); assert.equal(result.response.dedupeKey, proposal.dedupeKey);
  assert.doesNotMatch(result.response.text, /Já alterei/);
});

test('invented IDs, cleared selections and non-tool confirmations never reach the proposal executor', async t => {
  const f = fixture(t, { providers: { complete: async () => answer('', [call('prepare_category_changes', { changes: [{ transactionId: 'invented', categoryId: 'food' }] })]) } });
  await f.send('/sem_categoria'); assert.match((await f.send('categorize esse')).response.text, /INPUT_INVALID/); assert.equal(f.executions.length, 0);
  await f.send('/ia limpar'); assert.equal(f.service.repository.selection(), null); assert.equal(f.service.repository.history().length, 0);
  assert.match((await f.send('categorize 1')).response.text, /INPUT_INVALID/); assert.equal(f.executions.length, 0);
  const g = fixture(t, { providers: { complete: async () => answer('', [call('confirm_category_changes', { nonce: 'fake' })]) } });
  assert.match((await g.send('sim')).response.text, /INPUT_INVALID/); assert.equal(g.executions.length, 0);
});

test('Gemini transfer needs an explicit unexpired choice; local failure never selects a remote fallback', async t => {
  const f = fixture(t, { providers: { complete: async () => { throw new AppError('OLLAMA_TIMEOUT'); } } });
  await f.send('oi'); assert.deepEqual(f.requests.map(row => row.provider), ['ollama']);
  const proposal = (await f.send('/ia gemini')).response;
  assert.match(proposal.text, /contexto|histórico/i); assert.equal(f.requests.length, 1);
  f.advance(16 * 60000);
  await assert.rejects(f.send(proposal.replyMarkup.inline_keyboard[0][0].callback_data, { callback: true }), { code: 'PROPOSAL_EXPIRED' });
  assert.equal(f.service.repository.session().provider, 'ollama'); assert.equal(f.requests.length, 1);
});

test('persistent Gemini consent transfers only final content; returning local does not emit a remote request', async t => {
  const f = fixture(t);
  await f.send('/sem_categoria'); const proposal = (await f.send('/ia gemini')).response;
  await f.send(proposal.replyMarkup.inline_keyboard[0][0].callback_data, { callback: true });
  assert.equal(f.requests.length, 0); await f.send('explique os itens');
  assert.equal(f.requests.at(-1).provider, 'gemini');
  assert.ok(f.requests.at(-1).messages.some(row => row.content.includes('SEM CATEGORIA')));
  assert.ok(f.requests.at(-1).messages.every(row => !row.providerContent && !row.toolCalls && row.role !== 'tool'));
  await f.send('/ia ollama'); assert.equal(f.requests.length, 1); await f.send('olá novamente'); assert.equal(f.requests.at(-1).provider, 'ollama');
});

test('one-shot remote choice leaves the default local and rejects changed-context and foreign confirmations', async t => {
  const f = fixture(t);
  const first = (await f.send('/gemini explique meu orçamento')).response;
  await f.send('nova informação');
  await assert.rejects(f.send(first.replyMarkup.inline_keyboard[0][0].callback_data, { callback: true }), { code: 'PROPOSAL_POLICY_CHANGED' });
  const second = (await f.send('/gemini explique meu orçamento')).response;
  const callback = second.replyMarkup.inline_keyboard[0][0].callback_data;
  await assert.rejects(f.invoke({ type: 'callback', data: callback, identity: { ...f.identity, chatId: 999 } }), { code: 'UNAUTHORIZED' });
  await f.send(callback, { callback: true }); assert.equal(f.requests.at(-1).provider, 'gemini'); assert.equal(f.service.repository.session().provider, 'ollama');
  await assert.rejects(f.send(callback, { callback: true }), { code: 'PROPOSAL_USED' });
});

test('processed turn is replayed without another model call, including after restart', async t => {
  const f = fixture(t, { disk: true }); const sent = await f.send('oi'); f.restart();
  assert.deepEqual(await f.invoke(sent.request, sent.job), sent.response); assert.equal(f.requests.length, 1);
});

test('interrupted conversational turn does not replay model/tools after restart', async t => {
  const f = fixture(t, { disk: true });
  const request = { type: 'message', text: 'oi', identity: f.identity };
  f.store.enqueueJob({ kind: 'command', payload: request, dedupeKey: 'interrupted' }); const job = f.store.claimJob();
  f.service.repository.begin(request, job); f.restart();
  assert.match((await f.invoke(request, job)).text, /interrompida/); assert.equal(f.requests.length, 0);
});

test('history count and TTL remove response payloads even when an older turn was already pruned', async t => {
  const f = fixture(t, { assistant: { maxTurns: 2, historyTtlMinutes: 1 } });
  const first = await f.send('primeira'); await f.send('segunda'); await f.send('terceira');
  assert.equal(f.service.repository.history().length, 2);
  const old = f.store.db.prepare('SELECT * FROM conversation_turns WHERE source_job_id=?').get(first.job.id);
  assert.equal(old.user_text, null); assert.ok(old.response_json);
  f.advance(61000); f.service.repository.prune();
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM conversation_turns WHERE response_json IS NOT NULL OR selection_json IS NOT NULL').get().n, 0);
  assert.match((await f.invoke(first.request, first.job)).text, /já foi processada/); assert.equal(f.requests.length, 3);
});

test('clearing context leaves financial journal intact, while secrets and native fields never enter exported history', async t => {
  const f = fixture(t);
  await f.send('senha=PASSWORD_CANARY api_key=KEY_CANARY');
  assert.doesNotMatch(JSON.stringify(f.requests[0].messages), /PASSWORD_CANARY|KEY_CANARY/);
  await f.send('/ia limpar');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE name=?').get('002_operations.sql').n, 1);
  await f.send('oi'); assert.doesNotMatch(JSON.stringify(f.requests.at(-1).messages), /PASSWORD_CANARY|KEY_CANARY|senha=/);
});

test('eight stated installments with a smaller or truncated search ask for refinement before any proposed batch', async t => {
  for (const total of [2, 12]) {
    const f = fixture(t, { providers: { complete: async () => answer('', [call('search_transactions', { text: 'Brastemp*', start: '2026-09-01', end: '2027-04-30' }, 'search'), call('prepare_category_changes', { changes: [{ transactionId: 'tx-A', categoryId: 'food' }] }, 'prepare')]) }, tools: async () => search([transaction()], total) });
    const result = await f.send('Comprei uma lava-louças Brastemp em8 vezes. Busque as parcelas.');
    assert.match(result.response.text, /8 parcelas/); assert.match(result.response.text, /refinar/); assert.match(result.response.text, /Nenhuma alteração foi proposta/);
    assert.deepEqual(f.executions.map(row => row.name), ['search_transactions']);
  }
});

test('installment count from a different topic does not constrain a later unrelated search', async t => {
  let requests = 0;
  const f = fixture(t, { providers: { complete: async () => ++requests === 2 ? answer('', [call('search_transactions', { start: TODAY, end: TODAY })]) : answer('Vamos refinar sua pergunta.') } });
  await f.send('Comprei algo em8 vezes'); await f.send('Mudando de assunto, próximos lançamentos sem categoria');
  assert.equal(f.requests.length, 3); assert.doesNotMatch(f.service.repository.history().at(-1).assistant_text, /Você mencionou8 parcelas/);
});

test('model loop is bounded and preserves actual error codes rather than claiming a write', async t => {
  const f = fixture(t, { assistant: { maxToolRounds: 2 }, providers: { complete: async () => answer('', [call('search_transactions', { start: TODAY, end: TODAY })]) } });
  assert.match((await f.send('pesquise')).response.text, /limite de consultas/); assert.equal(f.requests.length, 2); assert.equal(f.executions.length, 2);
  const g = fixture(t, { providers: { complete: async () => answer('', [call('search_transactions', { start: TODAY, end: TODAY })]) }, tools: async () => { throw new AppError('ACTUAL_TIMEOUT'); } });
  assert.match((await g.send('pesquise')).response.text, /ACTUAL_TIMEOUT/); assert.match(g.service.repository.history().at(-1).assistant_text, /nenhuma confirmação foi assumida/);
});

test('context overflow drops complete historical frames, keeping current tool protocol and external selection outside system', async t => {
  let count = 0;
  const f = fixture(t, { providers: { complete: async () => {
    count++; if (count === 2) throw new AppError('CHAT_CONTEXT_LIMIT');
    return count === 1 ? answer('', [call('search_transactions', { start: TODAY, end: TODAY })]) : answer('Consulta concluída.');
  } } });
  await f.send('/sem_categoria'); const result = await f.send('Busque lançamentos');
  assert.match(result.response.text, /Contexto anterior reduzido/);
  const retry = f.requests.at(-1).messages;
  assert.doesNotMatch(retry[0].content, /tx-A|Brastemp fictícia/);
  assert.ok(retry.some(row => row.role === 'tool' && row.toolCallId === 'tool-1'));
  assert.ok(retry.some(row => row.role === 'assistant' && row.toolCalls?.[0]?.id === 'tool-1'));
  assert.ok(retry.some(row => row.role === 'user' && row.content.includes('DADOS OBSERVADOS')));
});

test('models are chosen only from inventory; selecting Gemini model never bypasses consent', async t => {
  const f = fixture(t);
  assert.match((await f.send('/ia modelo invented')).response.text, /não encontrado/);
  assert.equal(f.service.repository.session().model, null);
  assert.match((await f.send('/ia modelo fixture-local')).response.text, /selecionado/);
  assert.equal(f.service.repository.session().model, 'fixture-local'); assert.equal(f.service.repository.session().provider, 'ollama');
  const bad = fixture(t, { providers: { listModels: async () => [{ id: 'bad\n/confirmar fake' }] } });
  await assert.rejects(bad.send('/ia modelos'), { code: 'INPUT_INVALID' });
});

test('confirmed batch result is remembered as authoritative uncertainty for subsequent conversation', async t => {
  const f = fixture(t); await f.send('bf:synthetic', { callback: true }); await f.send('deu certo?');
  assert.ok(f.requests[0].messages.some(row => row.role === 'assistant' && /Resultado incerto/.test(row.content)));
  assert.ok(f.requests[0].messages.some(row => row.role === 'user' && /botão de confirmação/.test(row.content)));
});

test('conversation migration keeps original data and rejects a different identity binding', t => {
  const f = fixture(t, { disk: true });
  f.store.setPreference('fixture-preserved', { value: 1 }); f.restart();
  assert.deepEqual(f.store.getPreference('fixture-preserved'), { value: 1 });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE name=?').get('006_conversations.sql').n, 1);
  assert.throws(() => new ConversationStore(f.store, f.config).assert({ ...f.identity, budgetId: 'another' }), { code: 'UNAUTHORIZED' });
});

test('stale uncategorized result invalidates the earlier fresh selection instead of silently reusing it', async t => {
  const f = fixture(t, { providers: { complete: async () => answer('', [call('prepare_category_changes', { changes: [{ transactionId: '1', categoryId: 'food' }] })]) } });
  await f.send('/sem_categoria'); assert.ok(f.service.repository.selection().rows.length);
  f.actual.snapshot = async () => { throw new AppError('ACTUAL_TIMEOUT'); };
  assert.match((await f.send('/sem_categoria')).response.text, /DADOS DESATUALIZADOS/);
  assert.deepEqual(f.service.repository.selection().rows, []);
  await f.send('categorize 1'); assert.equal(f.executions.length, 0);
});

test('query_finances uncategorized tool selection uses structured rows and clears on stale response', async t => {
  let count = 0, stale = false;
  const f = fixture(t, { providers: { complete: async () => ++count % 2 ? answer('', [call('query_finances', { command: '/sem_categoria' })]) : answer('Aqui estão os itens.') },
    tools: async () => ({ data: { kind: 'financial_query', text: 'SEM CATEGORIA', selection: { ...search().data, dataState: stale ? 'stale' : 'fresh', eligible: !stale, clear: stale, transactions: stale ? [] : [transaction()] } } }) });
  await f.send('Liste os sem categoria'); assert.equal(f.service.repository.selection().rows[0].id, 'tx-A');
  stale = true; await f.send('Atualize essa consulta'); assert.deepEqual(f.service.repository.selection().rows, []);
});

test('recoverable tool argument error can be repaired in bounded rounds before an authoritative proposal', async t => {
  let count = 0;
  const f = fixture(t, { providers: { complete: async () => {
    count++; return answer('', [count < 3 ? call('search_transactions', { start: count === 1 ? 'invalid' : TODAY, end: TODAY }) : call('prepare_category_changes', { changes: [{ transactionId: '1', categoryId: 'food' }] })]);
  } }, tools: async (name, args) => {
    if (args.start === 'invalid') throw new AppError('INPUT_INVALID');
    return name === 'search_transactions' ? search() : { data: { kind: 'proposal' }, message: { text: 'Proposta válida; confirme no botão.', replyMarkup: { inline_keyboard: [[{ text: 'Confirmar', callback_data: 'bf:opaque' }]] } } };
  } });
  assert.match((await f.send('Procure e proponha uma categoria')).response.text, /^Proposta válida/);
  assert.equal(f.requests.length, 3); assert.match(f.requests[1].messages.find(row => row.role === 'tool').content, /INPUT_INVALID/);
  assert.deepEqual(f.executions.at(-1).args.changes, [{ transactionId: 'tx-A', categoryId: 'food' }]);
});

test('discarded oversized tool results cannot authorize IDs and multibyte history stays within the byte bound', async t => {
  let count = 0;
  const f = fixture(t, { assistant: { maxToolResultChars: 256, maxContextChars: 1500 }, providers: { complete: async () => ++count === 1 ? answer('', [call('search_transactions', { start: TODAY, end: TODAY })]) : answer('', [call('prepare_category_changes', { changes: [{ transactionId: 'tx-A', categoryId: 'food' }] })]) }, tools: async () => ({ data: { ...search().data, notice: 'á'.repeat(3000) } }) });
  await f.send('busque'); assert.equal(f.executions.length, 1); assert.equal(f.service.repository.selection()?.rows.length ?? 0, 0);
  const g = fixture(t, { assistant: { maxContextChars: 1500 }, providers: { complete: async () => answer('漢'.repeat(900)) } });
  await g.send('é'.repeat(400)); await g.send('é'.repeat(400));
  const history = g.service.repository.history();
  assert.ok(history.reduce((sum, row) => sum + Buffer.byteLength(row.user_text + row.assistant_text + (row.selection_json ?? '')), 0) <= 1500);
});

test('real ChatProviders HTTP encoding works through a local tool round with default 8192 context and retains only final conversation frames', async t => {
  const f = fixture(t), http = []; let chats = 0;
  f.service.providers = new ChatProviders({ ...f.config, gemini: { enabled: false }, ollama: { ...f.config.ollama, contextTokens: 8192 } }, { resolveSecret: async () => assert.fail('local provider requested a secret'), fetchImpl: async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null; http.push({ url, body });
    let data;
    if (url.endsWith('/api/tags')) data = { models: [{ name: 'fixture-local:latest', model: 'fixture-local:latest', size: 100, digest: 'a'.repeat(64), details: { format: 'gguf' } }] };
    else if (url.endsWith('/api/show')) data = { details: { format: 'gguf' }, capabilities: ['completion','tools'], model_info: { 'general.architecture': 'fixture', 'fixture.context_length': 32768 } };
    else if (url.endsWith('/api/chat')) { chats++; data = { model: 'fixture-local:latest', done: true, done_reason: 'stop', message: chats === 1 ? { role: 'assistant', content: '', thinking: 'NATIVE_PRIVATE_THINKING', tool_calls: [{ function: { name: 'search_transactions', arguments: { start: TODAY, end: TODAY, pageSize: 1 } } }] } : { role: 'assistant', content: 'Encontrei este lançamento.' }, prompt_eval_count: 20, eval_count: 10 }; }
    else assert.fail('Unexpected HTTP path');
    return new Response(JSON.stringify(data));
  } });
  const result = await f.send('Busque um lançamento');
  assert.equal(chats, 2); assert.match(result.response.text, /Encontrei este lançamento/); assert.match(result.response.text, /R\$ 123,45/);
  assert.ok(http.filter(row => row.url.endsWith('/api/chat'))[1].body.messages.some(row => row.role === 'tool'));
  assert.doesNotMatch(JSON.stringify(f.service.repository.history()), /NATIVE_PRIVATE_THINKING|providerContent|tool_calls/);
});

test('real Gemini HTTP receives no context before consent and no API key in body or exported history', async t => {
  const f = fixture(t), http = [];
  f.service.providers = new ChatProviders({ ...f.config, gemini: { enabled: true, model: 'fixture-remote', apiKeyRef: 'gemini-key' } }, { resolveSecret: async ref => { assert.equal(ref, 'gemini-key'); return 'SYNTHETIC_KEY_CANARY'; }, fetchImpl: async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null; http.push({ url, body, key: init.headers['x-goog-api-key'] });
    return new Response(JSON.stringify(body ? { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Olá pelo Gemini.' }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 } } : { name: 'models/fixture-remote', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 100000, outputTokenLimit: 8192 }));
  } });
  const pending = (await f.send('/gemini olá')).response; assert.equal(http.length, 0);
  const result = await f.send(pending.replyMarkup.inline_keyboard[0][0].callback_data, { callback: true });
  assert.match(result.response.text, /Olá pelo Gemini/); assert.equal(http.length, 2);
  assert.ok(http.every(row => row.key === 'SYNTHETIC_KEY_CANARY')); assert.doesNotMatch(JSON.stringify(http.map(row => row.body)), /SYNTHETIC_KEY_CANARY/);
  assert.doesNotMatch(JSON.stringify(f.service.repository.history()), /SYNTHETIC_KEY_CANARY/);
  assert.equal(f.service.repository.session().provider, 'ollama');
});
