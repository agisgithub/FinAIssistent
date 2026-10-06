import { AppError } from '../errors.mjs';

export function cents(value) {
  if (!Number.isSafeInteger(value)) throw new AppError('SNAPSHOT_INVALID');
  return value;
}
export const add = (a, b) => cents(cents(a) + cents(b));
export const subtract = (a, b) => cents(cents(a) - cents(b));
export const sum = values => values.reduce(add, 0);

// Keep the fractional cents as integers, including at MAX_SAFE_INTEGER.
export function formatMoney(value, currency = 'BRL') {
  cents(value);
  if (currency !== 'BRL') throw new AppError('INPUT_INVALID');
  const signed = BigInt(value), amount = signed < 0n ? -signed : signed;
  const integer = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(amount / 100n);
  return `${signed < 0n ? '-' : ''}R$ ${integer},${String(amount % 100n).padStart(2, '0')}`;
}

export function percentage(numerator, denominator) {
  cents(numerator); cents(denominator);
  if (denominator <= 0 || numerator < 0) return null;
  const tenths = (BigInt(numerator) * 1000n + BigInt(denominator) / 2n) / BigInt(denominator);
  return `${tenths / 10n},${tenths % 10n}%`;
}
