import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { conciseConversationText, ConversationService } from '../src/conversation/service.mjs';
import { encodePngPhoto } from '../src/telegram/media.mjs';
import { identityFromConfig } from '../src/policy/authorize.mjs';
import { renderMonthlySpendingMessage } from '../src/reports/chart.mjs';
import { processOneDelivery } from '../src/jobs/runtime.mjs';
import { memoryStore } from './helpers.mjs';

const photo = encodePngPhoto(PNG.sync.write(new PNG({ width: 2, height: 2 })), 'grafico.png');
function fixture(t, complete, toolMessage = () => ({ text: '📊 Consumo\n\nabr/26  R$ 10,00\nTotal R$ 10,00', photo })) {
  let clock = Date.parse('2026-09-20T12:00:00Z');
  const base = memoryStore(t, { now: () => clock }), config = { ...base.config, ollama: { ...base.config.ollama, enabled: true, model: 'fixture', localOnlyConfirmed: true }, assistant: { ...base.config.assistant, enabled: true } };
  const calls = [], executions = [], providers = { complete: async input => { calls.push(input); return complete(input); } };
  const financeTools = { execute: async (name, args) => { executions.push({ name, args }); return { data: { kind: 'monthly_spending_series', status: 'ok' }, message: toolMessage(args) }; } };
  const service = new ConversationService({ config, store: base.store, actual: {}, now: () => new Date('2026-09-20T12:00:00Z'), providers, financeTools });
  const send = async text => { const request = { type: 'message', text, identity: identityFromConfig(config) }; base.store.enqueueJob({ kind: 'command', payload: request, dedupeKey: `chart:${text}` }); const job = base.store.claimJob(); const response = await service.respond(request, job); base.store.completeJob(job.id, response); return response; };
  return { ...base, config, calls, executions, service, send, advance: milliseconds => { clock += milliseconds; } };
}

test('natural six-month category chart bypasses model uncertainty and persists one photo response', async t => {
  const f = fixture(t, () => { throw new Error('model must not run'); });
  const response = await f.send('Me dê o gráfico de gastos dos últimos 6 meses para Consumo.');
  assert.equal(f.calls.length, 0); assert.deepEqual(f.executions, [{ name: 'monthly_spending_series', args: { months: 6, categoryName: 'consumo', chartType: 'bar' } }]);
  assert.equal(response.photo.type, 'image/png');
  const outbox = f.store.db.prepare('SELECT * FROM outbox').get(); assert.equal(outbox.media_type, 'image/png'); assert.deepEqual(outbox.media_blob.subarray(0,8), Buffer.from('89504e470d0a1a0a','hex'));
});

test('model tool contract returns authoritative chart immediately and long ordinary chat is bounded', async t => {
  let round = 0;
  const f = fixture(t, () => ++round === 1
    ? { text: '', toolCalls: [{ id: 'chart-1', name: 'monthly_spending_series', args: { months: 6, categoryName: 'Consumo', chartType: 'line' } }], assistantMessage: { role: 'assistant', content: '', toolCalls: [{ id: 'chart-1', name: 'monthly_spending_series', args: { months: 6, categoryName: 'Consumo', chartType: 'line' } }] } }
    : { text: 'x'.repeat(3000), toolCalls: [], assistantMessage: { role: 'assistant', content: 'x'.repeat(3000), toolCalls: [] } });
  const chart = await f.send('Mostre a evolução mensal de Consumo.');
  assert.equal(round, 1); assert.equal(chart.photo.type, 'image/png'); assert.equal(f.executions[0].name, 'monthly_spending_series');
  const concise = await f.send('Explique de forma geral.');
  assert.ok(concise.text.length <= 600); assert.ok(concise.text.split('\n').length <= 6); assert.match(concise.text, /Resposta resumida/);
  assert.match(f.calls.at(-1).messages[0].content, /no máximo seis linhas/); assert.match(f.calls.at(-1).messages[0].content, /sem preâmbulo/);
});

test('compound graph and goal request completes both tools and keeps the chart in the final response', async t => {
  let round = 0;
  const toolCalls = [
    { id: 'chart-compound', name: 'monthly_spending_series', args: { months: 6, categoryName: 'Mercado', chartType: 'bar' } },
    { id: 'goal-compound', name: 'manage_financial_goal', args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000 } }
  ];
  const f = fixture(t, input => {
    round++;
    if (round === 1) return { text: '', toolCalls, assistantMessage: { role: 'assistant', content: '', toolCalls } };
    assert.equal(input.messages.filter(message => message.role === 'tool').length, 2);
    return { text: 'O gráfico foi gerado e considerei a meta Reserva.', toolCalls: [] };
  });
  f.service.tools = { execute: async (name, args) => {
    f.executions.push({ name, args });
    if (name === 'monthly_spending_series') return { data: { kind: 'monthly_spending_series', status: 'ok' }, message: { text: 'Gráfico de Mercado', photo } };
    return { data: { kind: 'companion_proposal', status: 'pending' }, message: { text: 'Proposta de meta Reserva; nada foi gravado.', replyMarkup: { inline_keyboard: [] } } };
  } };
  const response = await f.send('Crie minha meta Reserva de R$ 100 e compare com o gráfico de gastos dos últimos 6 meses para Mercado');
  assert.equal(round, 1); assert.deepEqual(f.executions.map(item => item.name), ['monthly_spending_series','manage_financial_goal']);
  assert.equal(response.photo.type, 'image/png'); assert.match(response.text, /meta Reserva/i);
});

test('compound goal and graph keeps the same proposal and photo when the model reverses tool order', async t => {
  const toolCalls = [
    { id: 'goal-first', name: 'manage_financial_goal', args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000 } },
    { id: 'chart-second', name: 'monthly_spending_series', args: { months: 6, categoryName: 'Mercado', chartType: 'bar' } }
  ];
  const f = fixture(t, () => ({ text: '', toolCalls, assistantMessage: { role: 'assistant', content: '', toolCalls } }));
  f.service.tools = { execute: async (name, args) => {
    f.executions.push({ name, args });
    if (name === 'monthly_spending_series') return { data: { kind: 'monthly_spending_series', status: 'ok' }, message: { text: 'Gráfico de Mercado', photo } };
    return { data: { kind: 'companion_proposal', status: 'pending' }, message: { text: 'Proposta de meta Reserva; nada foi gravado.', replyMarkup: { inline_keyboard: [] } } };
  } };
  const response = await f.send('Crie minha meta Reserva de R$ 100 e compare com o gráfico de gastos dos últimos 6 meses para Mercado');
  assert.deepEqual(f.executions.map(item => item.name), ['manage_financial_goal','monthly_spending_series']);
  assert.equal(response.photo.type, 'image/png'); assert.match(response.text, /Gráfico de Mercado/); assert.match(response.text, /Proposta de meta Reserva/);
});

test('compound monthly choice and companion proposal preserve both authoritative messages in either order', async t => {
  for (const order of [['monthly_spending_series','manage_financial_goal'], ['manage_financial_goal','monthly_spending_series']]) await t.test(order.join(' then '), async st => {
    const calls = order.map((name, index) => name === 'monthly_spending_series'
      ? { id: `choice-${index}`, name, args: { months: 6, categoryName: 'Mercado', chartType: 'bar' } }
      : { id: `goal-${index}`, name, args: { action: 'create', title: 'Reserva', metric: 'manual_savings_progress', targetCents: 10000 } });
    const f = fixture(st, () => ({ text: '', toolCalls: calls, assistantMessage: { role: 'assistant', content: '', toolCalls: calls } }));
    f.service.tools = { execute: async name => {
      f.executions.push({ name });
      if (name === 'monthly_spending_series') return { data: { kind: 'monthly_spending_series', status: 'choice_required' }, message: { text: 'Escolha Mercado — grupo Casa ou Mercado — grupo Alimentação.' } };
      return { data: { kind: 'companion_proposal', status: 'pending' }, message: { text: 'Proposta de meta Reserva; nada foi gravado.', replyMarkup: { inline_keyboard: [] } } };
    } };
    const response = await f.send('Crie minha meta Reserva e mostre o gráfico dos últimos 6 meses para Mercado');
    assert.deepEqual(f.executions.map(item => item.name), order);
    assert.equal(response.photo, undefined);
    assert.match(response.text, /Escolha Mercado/); assert.match(response.text, /Proposta de meta Reserva/);
  });
});

test('concise conversation formatter enforces six physical lines and a short single paragraph', () => {
  const result = conciseConversationText(Array.from({ length: 20 }, (_, index) => `linha ${index + 1}`).join('\n'));
  assert.equal(result.split('\n').length, 6);
  assert.match(result, /Resposta resumida/);
  assert.doesNotMatch(result, /linha 6/);
  const paragraph = conciseConversationText('x'.repeat(1500));
  assert.ok(paragraph.length <= 600); assert.match(paragraph, /Resposta resumida/);
});

test('authoritative chart choices without a photo are never shortened by the narrative formatter', async t => {
  const choices = Array.from({ length: 12 }, (_, index) => `Opção ${index + 1}: Mercado — Grupo ${index + 1}`).join('\n');
  const f = fixture(t, () => { throw new Error('model must not run'); }, () => ({ text: choices }));
  const response = await f.send('Me dê o gráfico de gastos dos últimos 6 meses para Mercado.');
  assert.equal(response.text, choices); assert.doesNotMatch(response.text, /Resposta resumida/);
});

function seriesMessage(months, { wide = false } = {}) {
  const cursor = new Date('2024-10-01T12:00:00Z'), rows = [];
  for (let index = 0; index < months; index++) {
    const month = cursor.toISOString().slice(0, 7), amount = wide ? 9_007_199_254_740_000 - index : (index + 1) * 100;
    rows.push({ month, grossCents: amount, refundCents: 0, netCents: amount, count: 1 }); cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const series = { kind: 'monthly_spending_series', status: 'ok', currency: 'BRL', period: { start: `${rows[0].month}-01`, end: `${rows.at(-1).month}-28` }, syncedAt: '2026-09-20T12:00:00Z',
    category: { name: wide ? 'Consumo '.repeat(13) : 'Consumo', groupName: wide ? 'Casa '.repeat(20) : 'Casa' }, months: rows,
    totals: { netCents: rows[0].netCents, averageNetCents: rows[0].netCents }, excluded: wide ? { parents: 12, transfers: 12, accounts: 12 } : { parents: 0, transfers: 0, accounts: 0 } };
  return { text: renderMonthlySpendingMessage(series), photo };
}

test('authoritative 12-month chart keeps every month through conversation and photo caption delivery', async t => {
  const f = fixture(t, () => { throw new Error('model must not run'); }, args => seriesMessage(args.months));
  const response = await f.send('Me dê o gráfico de gastos dos últimos 12 meses para Consumo.');
  assert.equal(response.text.split('\n').length, 14); assert.doesNotMatch(response.text, /Resposta resumida/);
  for (const label of ['out/24','nov/24','dez/24','jan/25','fev/25','mar/25','abr/25','mai/25','jun/25','jul/25','ago/25','set/25']) assert.match(response.text, new RegExp(label));
  const rows = f.store.db.prepare('SELECT payload,media_type FROM outbox ORDER BY rowid').all();
  assert.equal(rows[0].media_type, 'image/png'); assert.ok(JSON.parse(rows[0].payload).text.length <= 1024);
  assert.equal(rows.map(row => JSON.parse(row.payload).text).join(''), response.text);
  const delivered = [];
  assert.equal(await processOneDelivery({ store: f.store, telegram: { sendPhoto: async (_chat, payload) => (delivered.push(payload.text), 101) }, logger: () => {} }), true);
  assert.equal(delivered.join(''), response.text);
});

test('authoritative 24-month tool chart is split after rendering without losing accessible rows', async t => {
  let calls = 0;
  const f = fixture(t, () => (++calls, { text: '', toolCalls: [{ id: 'chart-24', name: 'monthly_spending_series', args: { months: 24, categoryName: 'Consumo', chartType: 'line' } }], assistantMessage: { role: 'assistant', content: '', toolCalls: [{ id: 'chart-24', name: 'monthly_spending_series', args: { months: 24, categoryName: 'Consumo', chartType: 'line' } }] } }), args => seriesMessage(args.months, { wide: true }));
  const response = await f.send('Mostre a evolução longa de Consumo.');
  assert.equal(calls, 1); assert.equal(response.text.split('\n').length, 26); assert.doesNotMatch(response.text, /Resposta resumida/);
  for (const label of ['out/24','set/25','set/26']) assert.match(response.text, new RegExp(label));
  const rows = f.store.db.prepare('SELECT payload,media_type FROM outbox ORDER BY rowid').all();
  assert.ok(rows.length > 1); assert.equal(rows[0].media_type, 'image/png'); assert.ok(JSON.parse(rows[0].payload).text.length <= 1024);
  assert.ok(rows.slice(1).every(row => row.media_type == null));
  assert.equal(rows.map(row => JSON.parse(row.payload).text).join(''), response.text);
  const delivered = [], telegram = {
    sendPhoto: async (_chat, payload) => (delivered.push(payload.text), 201),
    sendMessage: async (_chat, payload) => (delivered.push(payload.text), 202)
  };
  for (let index = 0; index < rows.length; index++) {
    assert.equal(await processOneDelivery({ store: f.store, telegram, logger: () => {} }), true); f.advance(1100);
  }
  assert.equal(delivered.join(''), response.text);
});
