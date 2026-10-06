import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { buildMonthlySpendingSeries, monthKeys, resolveSeriesCategory } from '../src/finance/series.mjs';
import { CHART_LIMITS, renderMonthlySpendingChart, renderMonthlySpendingMessage } from '../src/reports/chart.mjs';
import { decodePngPhoto, encodePngPhoto } from '../src/telegram/media.mjs';

const period = { start: '2026-04-01', end: '2026-09-20' };
const scope = { includeClosed: false, includeOffBudget: false };
const category = { id: 'consumption', name: 'Consumo', groupId: 'home', isIncome: false, hidden: false };
const base = overrides => ({ id: 'row', date: '2026-04-10', amountCents: -1000, categoryId: category.id, accountId: 'checking', payeeId: 'shop', transferId: null, isParent: false, ...overrides });

test('monthly spending keeps zero months and applies split, transfer, refund and scope semantics in integer cents', () => {
  const result = buildMonthlySpendingSeries({ request: { period, categoryName: 'Consumo', scope }, category, groupName: 'Casa', syncedAt: '2026-09-20T12:00:00Z', identity: { householdId: 'home', budgetId: 'budget' },
    accounts: [{ id: 'checking', closed: false, offBudget: false }, { id: 'off', closed: false, offBudget: true }],
    payees: [{ id: 'shop', transferAccountId: null }, { id: 'transfer-payee', transferAccountId: 'checking' }],
    transactions: [
      base({ id: 'normal' }), base({ id: 'split-child', amountCents: -500 }),
      base({ id: 'split-parent', amountCents: -500, isParent: true }),
      base({ id: 'linked-transfer', amountCents: -700, transferId: 'other' }),
      base({ id: 'payee-transfer', amountCents: -800, payeeId: 'transfer-payee' }),
      base({ id: 'off-budget', amountCents: -900, accountId: 'off' }),
      base({ id: 'refund', date: '2026-05-02', amountCents: 200 })
    ] });
  assert.deepEqual(result.months.map(row => row.month), ['2026-04','2026-05','2026-06','2026-07','2026-08','2026-09']);
  assert.deepEqual(result.months.map(row => row.netCents), [1500,-200,0,0,0,0]);
  assert.deepEqual(result.months.map(row => row.count), [2,1,0,0,0,0]);
  assert.deepEqual(result.excluded, { parents: 1, transfers: 2, accounts: 1 });
  assert.deepEqual(result.totals, { grossCents: 1500, refundCents: 200, netCents: 1300, averageNetCents: 217 });
});

test('category resolution never guesses missing or homonymous names and uses a human group label', () => {
  const categories = [category, { ...category, id: 'other', groupId: 'leisure' }, { ...category, id: 'fuel', name: 'Combustível', groupId: 'car' }];
  const groups = [{ id: 'home', name: 'Casa' }, { id: 'leisure', name: 'Lazer' }, { id: 'car', name: 'Carro' }];
  assert.equal(resolveSeriesCategory('Consumo', categories, groups).reason, 'ambiguous');
  assert.equal(resolveSeriesCategory('Consumo :: Casa', categories, groups).category.id, 'consumption');
  const missing = resolveSeriesCategory('Mercado inexistente', categories, groups);
  assert.equal(missing.reason, 'not_found'); assert.equal(missing.category, undefined);
  assert.deepEqual(monthKeys(period), ['2026-04','2026-05','2026-06','2026-07','2026-08','2026-09']);
});

test('category resolution unions literal and every qualified interpretation of separator names', () => {
  const categories = [
    { ...category, id: 'qualified', name: 'Consumo', groupId: 'home' },
    { ...category, id: 'literal', name: 'Consumo :: Casa', groupId: 'other' }
  ];
  const groups = [{ id: 'home', name: 'Casa' }, { id: 'other', name: 'Outros' }];
  const collision = resolveSeriesCategory('Consumo :: Casa', categories, groups);
  assert.equal(collision.reason, 'ambiguous');
  assert.deepEqual(new Set(collision.options.map(option => option.name)), new Set(['Consumo', 'Consumo :: Casa']));

  const nestedGroup = resolveSeriesCategory('Consumo :: Casa :: Principal',
    [{ ...category, id: 'nested-group', name: 'Consumo', groupId: 'nested' }],
    [{ id: 'nested', name: 'Casa :: Principal' }]);
  assert.equal(nestedGroup.category.id, 'nested-group');
  assert.equal(nestedGroup.groupName, 'Casa :: Principal');
});

test('PNG chart is bounded and readable as a standalone labeled chart; caption includes an accessible table', () => {
  const months = ['2026-04','2026-05','2026-06','2026-07','2026-08','2026-09'].map((month, index) => ({ month, grossCents: [1000,0,3500,900,1500,500][index], refundCents: index === 3 ? 1200 : 0, netCents: [1000,0,3500,-300,1500,500][index], count: index + 1 }));
  const series = { kind: 'monthly_spending_series', status: 'ok', currency: 'BRL', period, syncedAt: '2026-09-20T12:00:00Z', category: { name: 'Consumo', groupName: 'Casa' }, months, totals: { netCents: 6200, averageNetCents: 1033 }, excluded: { parents: 0, transfers: 1, accounts: 0 } };
  for (const chartType of ['bar','line']) {
    const bytes = renderMonthlySpendingChart(series, { chartType }), decoded = PNG.sync.read(bytes);
    assert.deepEqual([...bytes.subarray(0,8)], [137,80,78,71,13,10,26,10]);
    assert.equal(decoded.width, CHART_LIMITS.width); assert.equal(decoded.height, CHART_LIMITS.height);
    assert.ok(bytes.length < CHART_LIMITS.maxPngBytes);
    assert.ok(new Set(decoded.data).size > 8, 'chart contains text, grid and data colors');
    const photo = encodePngPhoto(bytes, `gastos-${chartType}.png`);
    assert.deepEqual(decodePngPhoto(photo).bytes, bytes);
  }
  const message = renderMonthlySpendingMessage(series);
  for (const label of ['abr/26','mai/26','jun/26','jul/26','ago/26','set/26']) assert.match(message, new RegExp(label));
  assert.match(message, /Total R\$ 62,00/); assert.match(message, /média mensal R\$ 10,33/); assert.match(message, /transferência/);
  assert.equal(message.split('\n').length, 8);
});

test('chart caption normalizes control, bidi and oversized Actual labels', () => {
  const months = ['2026-09'].map(month => ({ month, grossCents: 1000, refundCents: 0, netCents: 1000, count: 1 }));
  const hostile = { kind: 'monthly_spending_series', status: 'ok', currency: 'BRL', period: { start: '2026-09-01', end: '2026-09-20' }, syncedAt: '2026-09-20T12:00:00Z',
    category: { name: `Consumo\r\n/confirmar segredo\u202e${'x'.repeat(180)}`, groupName: `Casa\n${'y'.repeat(180)}` }, months,
    totals: { netCents: 1000, averageNetCents: 1000 }, excluded: { parents: 0, transfers: 0, accounts: 0 } };
  const message = renderMonthlySpendingMessage(hostile);
  assert.doesNotMatch(message, /[\r\u202e]/); assert.doesNotMatch(message, /\n\/confirmar/);
  assert.match(message, /…/); assert.ok(message.split('\n')[0].length < 230);
  assert.doesNotThrow(() => renderMonthlySpendingChart(hostile));
});
