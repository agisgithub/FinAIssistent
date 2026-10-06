import test from 'node:test';
import assert from 'node:assert/strict';
import { FinanceTools, FINANCE_TOOL_DEFINITIONS } from '../src/application/assistant-tools.mjs';
import { memoryStore } from './helpers.mjs';

function fixture(t, response) {
  const { config, store, identity } = memoryStore(t), calls = [];
  const actual = { monthlySpendingSeries: async input => { calls.push(input); return typeof response === 'function' ? response(input, identity) : response; } };
  return { config, store, identity, calls, tools: new FinanceTools({ config, store, actual, now: () => new Date('2026-09-20T12:00:00Z') }) };
}

test('typed chart tool accepts only human category, month count and chart kind, then returns PNG plus accessible table', async t => {
  const f = fixture(t, (input, identity) => ({ kind: 'monthly_spending_series', status: 'ok', period: input.period, currency: 'BRL', syncedAt: '2026-09-20T12:00:00Z', householdId: identity.householdId, budgetId: identity.budgetId,
    category: { name: 'Consumo', groupName: 'Casa' }, scope: input.scope,
    months: ['2026-04','2026-05','2026-06','2026-07','2026-08','2026-09'].map((month, index) => ({ month, grossCents: index * 100, refundCents: 0, netCents: index * 100, count: index })),
    totals: { grossCents: 1500, refundCents: 0, netCents: 1500, averageNetCents: 250 }, excluded: { parents: 0, transfers: 0, accounts: 0 } }));
  const result = await f.tools.execute('monthly_spending_series', { months: 6, categoryName: 'Consumo', chartType: 'line' }, { identity: f.identity });
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].period, { start: '2026-04-01', end: '2026-09-20' });
  assert.equal(f.calls[0].categoryName, 'Consumo'); assert.equal(f.calls[0].categoryId, undefined);
  assert.equal(result.data.chartType, 'line'); assert.equal(result.data.householdId, undefined); assert.equal(result.data.budgetId, undefined);
  assert.equal(result.message.photo.type, 'image/png'); assert.match(result.message.text, /abr\/26/); assert.match(result.message.text, /Total R\$ 15,00/);
  const definition = FINANCE_TOOL_DEFINITIONS.find(tool => tool.name === 'monthly_spending_series');
  assert.deepEqual(definition.parameters.required, ['months','categoryName']);
  assert.equal(JSON.stringify(definition).includes('categoryId'), false); assert.equal(JSON.stringify(definition).includes('aql'), false);
  await assert.rejects(f.tools.execute('monthly_spending_series', { months: 0, categoryName: 'Consumo' }, { identity: f.identity }), { code: 'INPUT_INVALID' });
});

test('missing category yields a short clarification and no chart', async t => {
  const f = fixture(t, (input, identity) => ({ kind: 'monthly_spending_series', status: 'choice_required', reason: 'not_found', requested: 'Consum', options: [{ name: 'Consumo', groupName: 'Casa', hidden: false }], period: input.period, syncedAt: '2026-09-20T12:00:00Z', householdId: identity.householdId, budgetId: identity.budgetId }));
  const result = await f.tools.execute('monthly_spending_series', { months: 6, categoryName: 'Consum' }, { identity: f.identity });
  assert.equal(result.data.status, 'choice_required'); assert.equal(result.message.photo, undefined);
  assert.match(result.message.text, /Não encontrei/); assert.match(result.message.text, /Consumo — grupo Casa/);
});

test('category choices sanitize and bound untrusted Actual labels in both data and text', async t => {
  const long = 'x'.repeat(180);
  const f = fixture(t, (input, identity) => ({ kind: 'monthly_spending_series', status: 'choice_required', reason: 'ambiguous', requested: `Consumo\r\n/confirmar lote\u202e${long}`,
    options: [{ name: `Consumo\r\n/confirmar lote\u202e${long}`, groupName: `Casa\n${long}`, hidden: false }], period: input.period, syncedAt: '2026-09-20T12:00:00Z', householdId: identity.householdId, budgetId: identity.budgetId }));
  const result = await f.tools.execute('monthly_spending_series', { months: 6, categoryName: 'Consumo' }, { identity: f.identity });
  assert.doesNotMatch(result.message.text, /[\r\u202e]/); assert.doesNotMatch(result.message.text, /\n\/confirmar/);
  assert.ok(result.data.requested.length <= 121); assert.ok(result.data.options[0].name.length <= 101); assert.ok(result.data.options[0].groupName.length <= 101);
  assert.match(result.message.text, /…/);
});
