import { AppError } from '../errors.mjs';
import { validDate, validatePeriod } from '../actual/snapshot.mjs';

export function localToday(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = key => parts.find(part => part.type === key).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export const normalizeText = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');

export function boundedPeriod(period, today) {
  validatePeriod(period);
  if (!validDate(today) || period.end > today) throw new AppError('INPUT_INVALID');
  return Object.freeze({ start: period.start, end: period.end });
}
export function calendarMonths(count, today) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 24 || !validDate(today)) throw new AppError('INPUT_INVALID');
  const date = new Date(today.slice(0, 7) + '-01T12:00:00Z');
  date.setUTCMonth(date.getUTCMonth() - count + 1);
  return boundedPeriod({ start: date.toISOString().slice(0, 10), end: today }, today);
}
export function resolvePeriod(input, today) {
  const text = normalizeText(input ?? '');
  if (!text || ['mes', 'este mes', 'no mes', 'mes atual'].includes(text)) return calendarMonths(1, today);
  if (['hoje', 'de hoje'].includes(text)) return boundedPeriod({ start: today, end: today }, today);
  if (text === 'ontem') {
    const day = new Date(today + 'T12:00:00Z'); day.setUTCDate(day.getUTCDate() - 1);
    return boundedPeriod({ start: day.toISOString().slice(0, 10), end: day.toISOString().slice(0, 10) }, today);
  }
  if (text === 'mes passado') {
    const day = new Date(today.slice(0, 7) + '-01T12:00:00Z'); day.setUTCDate(0);
    const end = day.toISOString().slice(0, 10);
    return boundedPeriod({ start: end.slice(0, 7) + '-01', end }, today);
  }
  const months = /^(?:nos )?(?:ultimos )?(\d+|seis) meses$/.exec(text);
  if (months) return calendarMonths(months[1] === 'seis' ? 6 : Number(months[1]), today);
  const dates = /^(\d{4}-\d{2}-\d{2})(?:\s+(?:a |ate )?(\d{4}-\d{2}-\d{2}))?$/.exec(text);
  if (dates) return boundedPeriod({ start: dates[1], end: dates[2] ?? dates[1] }, today);
  throw new AppError('INPUT_INVALID');
}
