import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchedules } from '../src/actual/schedules.mjs';

const config = { householdId: 'synthetic', actual: { budgetId: 'synthetic-budget' }, timezone: 'America/Sao_Paulo', currency: 'BRL' };
const row = () => ({ id: 'schedule', name: 'Synthetic schedule', rule: 'rule', next_date: '2026-09-30', completed: false, posts_transaction: true, payee: 'payee', account: 'account', amount: -12345, amountOp: 'is', date: '2026-09-30' });
const normalize = (schedules, overrides = {}) => normalizeSchedules({ config, schedules, syncedAt: '2026-09-15T12:00:00Z', ...overrides });

test('schedule normalization is closed, signed and stable across reads; flags never become payment status', () => {
  const raw = row(), before = normalize([{ ...raw, internalSecret: 'never copied' }]);
  const after = normalize([raw], { syncedAt: '2026-09-16T12:00:00Z' });
  assert.deepEqual(before.coverage, { complete: true });
  assert.equal(before.rulesVersion, 'schedules-1');
  assert.equal(before.timezone, config.timezone);
  assert.deepEqual(before.schedules[0], {
    id: raw.id, name: raw.name, ruleId: raw.rule, nextDate: raw.next_date,
    completed: false, postsTransaction: true, payeeId: raw.payee, accountId: raw.account,
    amountCents: -12345, amountRange: null, amountOp: 'is', date: raw.date,
    fingerprint: after.schedules[0].fingerprint
  });
  assert.equal(before.schedules[0].status, undefined);
  assert.match(before.schedules[0].fingerprint, /^[a-f0-9]{64}$/);
  for (const patch of [{ name: 'Renamed' }, { next_date: '2026-10-01' }, { posts_transaction: false }, { completed: true }, { amount: -20000 }, { account: 'other-account' }, { rule: 'other-rule' }]) {
    assert.notEqual(normalize([{ ...raw, ...patch }]).schedules[0].fingerprint, before.schedules[0].fingerprint);
  }
  assert.notEqual(normalize([raw], { config: { ...config, householdId: 'other' } }).schedules[0].fingerprint, before.schedules[0].fingerprint);
});

test('valid SDK recurrence metadata survives without local expansion, defaults or loss of uncommon patterns', () => {
  const dates = [
    { frequency: 'weekly', start: '2026-09-01', interval: 2, endMode: 'on_date', endDate: '2027-01-01' },
    { frequency: 'monthly', start: '2026-09-30', patterns: [{ type: 'day', value: -1 }, { type: 'MO', value: -1 }], skipWeekend: true, weekendSolveMode: 'before', endMode: 'after_n_occurrences', endOccurrences: 3 },
    { frequency: 'daily', start: '2026-09-01' },
    { frequency: 'yearly', start: '2024-02-29', interval: 1, endMode: 'never', skipWeekend: false }
  ];
  for (const value of dates) assert.deepEqual(normalize([{ ...row(), date: value }]).schedules[0].date, value);
  const first = normalize([{ ...row(), date: dates[0] }]).schedules[0];
  const reordered = normalize([{ ...row(), date: Object.fromEntries(Object.entries(dates[0]).reverse()) }]).schedules[0];
  assert.equal(first.fingerprint, reordered.fingerprint);
  assert.equal(normalize([{ ...row(), date: dates[2] }]).schedules[0].date.interval, undefined);
});

test('schedule amount ranges retain cents and missing labels/identities remain null; SDK zero is kept', () => {
  const range = normalize([{ ...row(), amountOp: 'isbetween', amount: { num1: Number.MAX_SAFE_INTEGER, num2: -Number.MAX_SAFE_INTEGER } }]).schedules[0];
  assert.equal(range.amountCents, null);
  assert.deepEqual(range.amountRange, { minCents: -Number.MAX_SAFE_INTEGER, maxCents: Number.MAX_SAFE_INTEGER });
  const missing = normalize([{ ...row(), name: undefined, account: null, payee: null, amount: 0, amountOp: 'isapprox' }]).schedules[0];
  assert.equal(missing.name, null); assert.equal(missing.accountId, null); assert.equal(missing.payeeId, null); assert.equal(missing.amountCents, 0);
  assert.deepEqual(normalize([]).schedules, []);
});

test('malformed schedule results fail the entire catalog without claiming partial coverage', () => {
  const malformed = [
    null, { ...row(), id: 'invalid/id' }, { ...row(), rule: null }, { ...row(), next_date: '2026-02-29' },
    { ...row(), completed: 'false' }, { ...row(), posts_transaction: 1 },
    { ...row(), amount: Number.MAX_SAFE_INTEGER + 1 }, { ...row(), amount: null },
    { ...row(), amountOp: 'unknown' }, { ...row(), amountOp: 'isbetween', amount: -100 },
    { ...row(), amountOp: 'isbetween', amount: { num1: -100, num2: 2.5 } },
    { ...row(), date: { frequency: 'fortnight', start: '2026-09-01' } },
    { ...row(), date: { frequency: 'weekly', start: 'not-a-date' } },
    { ...row(), date: { frequency: 'monthly', start: '2026-09-01', patterns: [{ type: 'unknown', value: 1 }] } },
    { ...row(), date: { frequency: 'daily', start: '2026-09-01', endMode: 'on_date' } },
    { ...row(), date: { frequency: 'daily', start: '2026-09-01', script: 'not copied' } }
  ];
  for (const invalid of malformed) assert.throws(() => normalize([invalid]), { code: 'SNAPSHOT_INVALID' });
  assert.throws(() => normalize([row(), { ...row(), id: 'other', date: 'invalid' }]), { code: 'SNAPSHOT_INVALID' });
  assert.throws(() => normalize([row(), row()]), { code: 'SNAPSHOT_INVALID' });
  assert.throws(() => normalize({ data: [] }), { code: 'SNAPSHOT_INVALID' });
  assert.throws(() => normalize([], { syncedAt: 'bad' }), { code: 'SNAPSHOT_INVALID' });
});
