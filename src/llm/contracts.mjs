import { AppError } from '../errors.mjs';
import { validDate, validatePeriod } from '../actual/snapshot.mjs';

export const INTENT_KINDS = Object.freeze(['summary', 'spending', 'budget', 'uncategorized', 'leaks', 'accounts']);
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const QUERY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['kind', 'period', 'page'],
  properties: {
    kind: { type: 'string', enum: [...INTENT_KINDS] },
    period: {
      type: 'object', additionalProperties: false, required: ['start', 'end'],
      properties: { start: { type: 'string', format: 'date' }, end: { type: 'string', format: 'date' } }
    },
    page: { type: 'integer', minimum: 1, maximum: 100000 }
  }
};
export const INTENT_SCHEMA = freeze({ anyOf: [QUERY_SCHEMA, {
  type: 'object', additionalProperties: false, required: ['kind'],
  properties: { kind: { type: 'string', enum: ['unsupported'] } }
}] });

export function validateIntent(input, { today } = {}) {
  if (!validDate(today)) throw new AppError('INPUT_INVALID');
  if (input && typeof input === 'object' && input.kind === 'unsupported' && !Array.isArray(input) && Object.keys(input).length === 1) return Object.freeze({ kind: 'unsupported' });
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== 3 || Object.keys(input).some(key => !['kind', 'period', 'page'].includes(key)) ||
      !INTENT_KINDS.includes(input.kind) || !Number.isSafeInteger(input.page) || input.page < 1 || input.page > 100000 || !validDate(today)) throw new AppError('INPUT_INVALID');
  validatePeriod(input.period);
  if (input.period.end > today) throw new AppError('INPUT_INVALID');
  return Object.freeze({ kind: input.kind, period: Object.freeze({ start: input.period.start, end: input.period.end }), page: input.page });
}
