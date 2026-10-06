import { createHash } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { validDate } from './snapshot.mjs';
import { validId } from './transaction.mjs';

const invalid = () => { throw new AppError('SNAPSHOT_INVALID'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => validId(value) ? value : invalid();
const optionalId = value => value == null || value === '' ? null : id(value);
const integer = value => Number.isSafeInteger(value) ? value : invalid();
const boolean = value => typeof value === 'boolean' ? value : invalid();
const string = (value, max = 500) => typeof value === 'string' && value.length <= max ? value : invalid();
const date = value => validDate(value) ? value : invalid();

function recurrence(value) {
  if (typeof value === 'string') return date(value);
  const keys = ['frequency', 'start', 'interval', 'patterns', 'skipWeekend', 'endMode', 'endOccurrences', 'endDate', 'weekendSolveMode'];
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || !['daily', 'weekly', 'monthly', 'yearly'].includes(value.frequency)) invalid();
  const result = { frequency: value.frequency, start: date(value.start) };
  // Preserve the SDK's typed optional metadata rather than expand a recurrence
  // or invent defaults. Local calendar support is a separate domain decision.
  if ('interval' in value) result.interval = integer(value.interval);
  if ('patterns' in value) {
    if (!Array.isArray(value.patterns) || value.patterns.length > 1000) invalid();
    result.patterns = value.patterns.map(pattern => {
      if (!object(pattern) || Object.keys(pattern).length !== 2 || !['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'day'].includes(pattern.type)) invalid();
      return { type: pattern.type, value: integer(pattern.value) };
    });
  }
  if ('skipWeekend' in value) result.skipWeekend = boolean(value.skipWeekend);
  if ('endMode' in value) {
    if (!['never', 'after_n_occurrences', 'on_date'].includes(value.endMode)) invalid();
    result.endMode = value.endMode;
  }
  if ('endOccurrences' in value) result.endOccurrences = integer(value.endOccurrences);
  if ('endDate' in value) result.endDate = date(value.endDate);
  if ('weekendSolveMode' in value) {
    if (!['before', 'after'].includes(value.weekendSolveMode)) invalid();
    result.weekendSolveMode = value.weekendSolveMode;
  }
  if (result.endMode === 'after_n_occurrences' && !('endOccurrences' in result)) invalid();
  if (result.endMode === 'on_date' && !('endDate' in result)) invalid();
  return result;
}

export function normalizeSchedules({ config, schedules, syncedAt }) {
  if (!Array.isArray(schedules) || schedules.length > 10000 || typeof syncedAt !== 'string' || !Number.isFinite(Date.parse(syncedAt))) invalid();
  const context = { householdId: id(config.householdId), budgetId: id(config.actual.budgetId), timezone: string(config.timezone, 128), currency: string(config.currency, 3) };
  const seen = new Set();
  const rows = schedules.map(row => {
    if (!object(row) || !['is', 'isapprox', 'isbetween'].includes(row.amountOp)) invalid();
    let amountCents = null, amountRange = null;
    if (row.amountOp === 'isbetween') {
      if (!object(row.amount) || Object.keys(row.amount).length !== 2 || !('num1' in row.amount) || !('num2' in row.amount)) invalid();
      const a = integer(row.amount.num1), b = integer(row.amount.num2);
      amountRange = { minCents: Math.min(a, b), maxCents: Math.max(a, b) };
    } else amountCents = integer(row.amount);
    const normalized = {
      id: id(row.id), name: row.name == null ? null : string(row.name), ruleId: id(row.rule),
      nextDate: date(row.next_date), completed: boolean(row.completed), postsTransaction: boolean(row.posts_transaction),
      payeeId: optionalId(row.payee), accountId: optionalId(row.account),
      amountCents, amountRange, amountOp: row.amountOp, date: recurrence(row.date)
    };
    if (seen.has(normalized.id)) invalid();
    seen.add(normalized.id);
    const fingerprint = createHash('sha256').update(JSON.stringify({ version: 'schedules-1', ...context, schedule: normalized })).digest('hex');
    return { ...normalized, fingerprint };
  });
  return { ...context, syncedAt, createdAt: new Date().toISOString(), rulesVersion: 'schedules-1', coverage: { complete: true }, schedules: rows };
}
