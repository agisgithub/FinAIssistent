import test from 'node:test';
import assert from 'node:assert/strict';
import { localToday, resolvePeriod } from '../src/finance/periods.mjs';
import { parseQuery } from '../src/application/dispatch.mjs';

test('periods use the household timezone, inclusive boundaries and calendar-month windows', () => {
  assert.equal(localToday('America/Sao_Paulo', new Date('2026-10-01T02:59:59Z')), '2026-09-30');
  assert.equal(localToday('America/Sao_Paulo', new Date('2026-10-01T03:00:00Z')), '2026-10-01');
  assert.deepEqual(resolvePeriod('mês passado', '2024-03-01'), { start: '2024-02-01', end: '2024-02-29' });
  assert.deepEqual(resolvePeriod('últimos seis meses', '2026-09-15'), { start: '2026-04-01', end: '2026-09-15' });
  assert.deepEqual(resolvePeriod('hoje', '2026-09-15'), { start: '2026-09-15', end: '2026-09-15' });
  assert.deepEqual(resolvePeriod('2026-08-01 2026-08-31', '2026-09-15'), { start: '2026-08-01', end: '2026-08-31' });
  for (const value of ['2026-02-29', '2026-09-16', '25 meses', '2026-09-10 2026-09-01']) assert.throws(() => resolvePeriod(value, '2026-09-15'), { code: 'INPUT_INVALID' });
});
test('deterministic parser covers commands and simple natural questions without model interpretation', () => {
  const today = '2026-09-15';
  assert.deepEqual(parseQuery('Quanto gastei hoje?', { today }), { kind: 'spending', period: { start: today, end: today }, page: 1 });
  assert.deepEqual(parseQuery('resumo nos últimos seis meses', { today }), { kind: 'summary', period: { start: '2026-04-01', end: today }, page: 1 });
  assert.equal(parseQuery('/sem_categoria 2026-08-01 2026-08-31 pagina 2', { today }).page, 2);
  assert.equal(parseQuery('onde gasto mais este mês?', { today }).kind, 'leaks');
  assert.equal(parseQuery('/unknown', { today }), null);
  assert.throws(() => parseQuery('/gastos 2026-02-30', { today }), { code: 'INPUT_INVALID' });
});
