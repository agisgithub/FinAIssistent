import { AppError } from '../errors.mjs';
import { validDate, validatePeriod } from '../actual/snapshot.mjs';
import { comparisonPeriods } from '../finance/periods.mjs';

export const INTENT_KINDS = Object.freeze(['summary', 'spending', 'budget', 'uncategorized', 'leaks', 'accounts', 'comparison']);
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const QUERY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['kind', 'period', 'page'],
  properties: {
    kind: { type: 'string', enum: INTENT_KINDS.filter(kind => kind !== 'spending') },
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
}, {
  type: 'object', additionalProperties: false, required: ['kind', 'topic'],
  properties: { kind: { type: 'string', enum: ['needs_info'] }, topic: { type: 'string', enum: ['installment', 'savings'] } }
}, {
  ...QUERY_SCHEMA,
  properties: { ...QUERY_SCHEMA.properties, kind: { type: 'string', enum: ['spending'] }, categoryName: { type: 'string', minLength: 1, maxLength: 500 } }
}] });

export function validateIntent(input, { today } = {}) {
  if (!validDate(today)) throw new AppError('INPUT_INVALID');
  if (input && typeof input === 'object' && input.kind === 'unsupported' && !Array.isArray(input) && Object.keys(input).length === 1) return Object.freeze({ kind: 'unsupported' });
  if (input && typeof input === 'object' && !Array.isArray(input) && input.kind === 'needs_info' && Object.keys(input).length === 2 && ['installment', 'savings'].includes(input.topic)) return Object.freeze({ kind: 'needs_info', topic: input.topic });
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![3, 4].includes(Object.keys(input).length) || Object.keys(input).some(key => !['kind', 'period', 'page', 'categoryName'].includes(key)) ||
      !INTENT_KINDS.includes(input.kind) || !Number.isSafeInteger(input.page) || input.page < 1 || input.page > 100000 || !validDate(today)) throw new AppError('INPUT_INVALID');
  validatePeriod(input.period);
  if (input.period.end > today) throw new AppError('INPUT_INVALID');
  if (Object.hasOwn(input, 'categoryName') && (input.kind !== 'spending' || typeof input.categoryName !== 'string' || !input.categoryName.trim() || input.categoryName.length > 500 || /[\u0000-\u001f\u007f-\u009f]/.test(input.categoryName))) throw new AppError('INPUT_INVALID');
  if (input.kind === 'comparison') {
    const expected = comparisonPeriods(today).period;
    if (input.period.start !== expected.start || input.period.end !== expected.end) throw new AppError('INPUT_INVALID');
  }
  return Object.freeze({ kind: input.kind, period: Object.freeze({ start: input.period.start, end: input.period.end }), page: input.page, ...(input.categoryName === undefined ? {} : { categoryName: input.categoryName.trim() }) });
}
