import test from 'node:test';
import assert from 'node:assert/strict';
import { transactionSearchIntent } from '../src/conversation/search-intent.mjs';
import { resolvePeriod, localToday } from '../src/finance/periods.mjs';

const today = '2026-09-15';
test('reported natural search requests use explicit bounded periods instead of today only', () => {
  const named = transactionSearchIntent('Procure por Brastemp* nos meus lançamentos', today);
  assert.deepEqual(named.args, { start: '2025-10-01', end: '2027-09-30', text: 'brastemp*', page: 1, pageSize: 10 });
  assert.match(named.notice, /próximos 12/);
  const latest = transactionSearchIntent('Quais foram meus ultimoslançamentos?', today);
  assert.deepEqual(latest.args, { start: '2025-10-01', end: today, page: 1, pageSize: 10 });
  assert.match(latest.notice, /por data/);
  const week = transactionSearchIntent('Me de os lançamentos da semana passada inteira.', today);
  assert.deepEqual(week.args, { start: '2026-09-07', end: '2026-09-13', page: 1, pageSize: 10 });
});

test('explicit dates and relative periods preserve merchant filters and calendar boundaries', () => {
  assert.deepEqual(transactionSearchIntent('Procure Brastemp* nos últimos 3 meses', today).args,
    { start: '2026-07-01', end: today, text: 'brastemp*', page: 1, pageSize: 10 });
  assert.deepEqual(transactionSearchIntent('Procure "Loja São João*" nos meus lançamentos da semana passada', today).args,
    { start: '2026-09-07', end: '2026-09-13', text: 'loja sao joao*', page: 1, pageSize: 10 });
  assert.equal(transactionSearchIntent('Procure Brastemp nos próximos 3 meses', today).args.end, '2026-12-15');
  assert.equal(transactionSearchIntent('Procure Brastemp nos próximos 1 meses', '2028-01-31').args.end, '2028-02-29');
  assert.deepEqual(transactionSearchIntent('Me liste os últimos lançamentos de 2026-09-01 a 2026-09-14', today).args,
    { start: '2026-09-01', end: '2026-09-14', page: 1, pageSize: 10 });
  assert.deepEqual(resolvePeriod('semana passada inteira', '2026-01-01'), { start: '2025-12-22', end: '2025-12-28' });
  assert.deepEqual(resolvePeriod('semana passada', '2026-09-13'), { start: '2026-08-31', end: '2026-09-06' });
  assert.deepEqual(resolvePeriod('esta semana', today), { start: '2026-09-14', end: today });
  assert.deepEqual(resolvePeriod('ultimos 3 dias', '2028-03-01'), { start: '2028-02-28', end: '2028-03-01' });
  const local = localToday('America/Sao_Paulo', new Date('2026-09-14T01:00:00Z'));
  assert.equal(local, '2026-09-13');
  assert.equal(transactionSearchIntent('Mostre os lançamentos da semana passada', local).args.end, '2026-09-06');
});

test('shortcut does not discard extra conditions, unsupported periods or write instructions', () => {
  for (const input of ['Procure Brastemp na conta X', 'Procure Brastemp e categorize tudo', 'Me liste os lançamentos acima de 500', 'Me liste os lançamentos de agosto', 'Procure Brastemp nos últimos 30 meses', 'Procure Brastemp nos últimos 0 dias', 'Busque lançamentos', 'Busque um lançamento', 'Procure "Brastemp"; exclua tudo', '/confirmar token']) {
    assert.equal(transactionSearchIntent(input, today), null, input);
  }
});
