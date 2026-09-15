import { createHash } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { validDate, validMonth } from '../actual/snapshot.mjs';
import { validId } from '../actual/transaction.mjs';

export const RECURRENCE_RULES_VERSION = 'recurrence-1';
const invalid = () => { throw new AppError('INPUT_INVALID'); };
export const recurrenceId = (prefix, values) => `${prefix}_${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
export function assertRecurrenceIdentity(identity, row = identity) {
  if (!identity || !validId(identity.householdId) || !validId(identity.budgetId) || !row || row.householdId !== identity.householdId || row.budgetId !== identity.budgetId) throw new AppError('UNAUTHORIZED');
}
export function shiftMonth(month, offset) {
  if (!validMonth(month) || !Number.isSafeInteger(offset) || Math.abs(offset) > 24) invalid();
  const date = new Date(`${month}-01T12:00:00Z`); date.setUTCMonth(date.getUTCMonth() + offset);
  const result = date.toISOString().slice(0, 7);
  if (!validMonth(result)) invalid();
  return result;
}
export function monthLastDay(month) {
  if (!validMonth(month)) invalid();
  const date = new Date(`${month}-01T12:00:00Z`); date.setUTCMonth(date.getUTCMonth() + 1); date.setUTCDate(0);
  return date.getUTCDate();
}
export function validateRecurrenceBill(row, identity) {
  assertRecurrenceIdentity(identity, row);
  if (!['id','unitId','payeeId','accountId'].every(key => validId(row[key])) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 500 ||
      !['manual','history','actual'].includes(row.source) || !(row.sourceScheduleId === null || validId(row.sourceScheduleId)) ||
      !validMonth(row.startCompetence) || !(row.endCompetence === null || validMonth(row.endCompetence) && row.endCompetence >= row.startCompetence) ||
      !Number.isSafeInteger(row.dueDay) || row.dueDay < 1 || row.dueDay > 31 || ![0,1].includes(row.monthOffset) ||
      !['confirmed','estimated'].includes(row.dateKind) || row.dateSource !== (row.dateKind === 'confirmed' ? 'user_confirmed' : 'user_estimate') ||
      !(row.referenceAmountCents === null || Number.isSafeInteger(row.referenceAmountCents) && row.referenceAmountCents > 0) ||
      typeof row.active !== 'boolean' || !Number.isSafeInteger(row.revision) || row.revision < 1) invalid();
  // Projection keeps persistence and reminder policies outside the pure domain.
  return Object.fromEntries(['id','householdId','budgetId','unitId','name','payeeId','accountId','source','sourceScheduleId','startCompetence','endCompetence','dueDay','monthOffset','dateKind','dateSource','referenceAmountCents','active','revision'].map(key => [key,row[key]]));
}
export function deriveOccurrenceState(row, { today, match, matchState = match?.state ?? 'none' } = {}) {
  if (!validDate(today) || !validDate(row?.dueDate) || !['confirmed','estimated'].includes(row.dateKind) || !['open','paid_manual','cancelled'].includes(row.localState) || !['none','unknown','compatible','ambiguous'].includes(matchState)) invalid();
  const paymentConfirmed = row.localState === 'paid_manual';
  const state = row.localState === 'cancelled' ? 'cancelled' : paymentConfirmed ? 'paid_manual'
    : row.dateKind === 'confirmed' && row.dueDate < today ? 'overdue'
      : matchState === 'compatible' ? 'compatible' : 'planned';
  return { state, paymentConfirmed, estimatedDatePassed: row.dateKind === 'estimated' && row.dueDate < today, documentStatus: 'unverified' };
}
export function buildCalendar(bills, { identity, from, to, today, timezone } = {}) {
  assertRecurrenceIdentity(identity);
  if (!Array.isArray(bills) || bills.length > 1000 || !validMonth(from) || !validMonth(to) || from > to || to > shiftMonth(from,11) || !validDate(today) || typeof timezone !== 'string' || !timezone || timezone !== identity.timezone) invalid();
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { invalid(); }
  const normalized = bills.map(row => validateRecurrenceBill(row, identity));
  if (new Set(normalized.map(row => row.id)).size !== normalized.length) invalid();
  const occurrences = [];
  for (const bill of normalized.filter(row => row.active)) {
    for (let competence = from; competence <= to; competence = shiftMonth(competence,1)) {
      if (competence < bill.startCompetence || bill.endCompetence !== null && competence > bill.endCompetence) continue;
      const month = shiftMonth(competence,bill.monthOffset), day = Math.min(bill.dueDay,monthLastDay(month));
      occurrences.push({ id: recurrenceId('occ',[identity.householdId,identity.budgetId,bill.id,competence]), householdId: identity.householdId, budgetId: identity.budgetId,
        billId: bill.id, unitId: bill.unitId, name: bill.name, payeeId: bill.payeeId, accountId: bill.accountId, sourceScheduleId: bill.sourceScheduleId,
        competence, dueDate: `${month}-${String(day).padStart(2,'0')}`, dateKind: bill.dateKind, dateSource: bill.dateSource, adjusted: day !== bill.dueDay,
        expectedAmountCents: bill.referenceAmountCents, billRevision: bill.revision, localState: 'open', revision: 1 });
    }
  }
  occurrences.sort((a,b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
  return { occurrences, metadata: { householdId: identity.householdId, budgetId: identity.budgetId, timezone, from, to, today, rulesVersion: RECURRENCE_RULES_VERSION, source: 'local_templates', registeredCount: normalized.length } };
}
