import { AppError } from '../errors.mjs';
import { transactionFingerprint, validId } from '../actual/transaction.mjs';
import { validDate } from '../actual/snapshot.mjs';
import { analyzeSnapshot, DEFAULT_SCOPE } from '../finance/analyze.mjs';
import { boundedPeriod, calendarMonths } from '../finance/periods.mjs';
import { assertRecurrenceIdentity, recurrenceId, RECURRENCE_RULES_VERSION, shiftMonth, validateRecurrenceBill } from './calendar.mjs';

const invalid = () => { throw new AppError('SNAPSHOT_INVALID'); };
const MAX_ROWS = 100000;
export function recurrenceTransactionFingerprint(identity, row) {
  assertRecurrenceIdentity(identity);
  // Old snapshots omitted these fields. They remain readable elsewhere, but
  // cannot authorize an assignment or supply fresh recurrence evidence.
  if (!row || !['id','accountId','date','amount','payeeId','notes','categoryId','parentId','isParent','isChild','transferId','cleared','reconciled','startingBalance','scheduleId'].every(key => Object.hasOwn(row,key)) ||
      !['isParent','isChild','cleared','reconciled','startingBalance'].every(key => typeof row[key] === 'boolean') ||
      !['payeeId','categoryId','parentId','transferId','scheduleId'].every(key => row[key] === null || validId(row[key])) ||
      row.isParent && (row.isChild || row.parentId !== null) || row.isChild !== (row.parentId !== null)) invalid();
  try { return transactionFingerprint(identity,row); } catch { invalid(); }
}
const evidenceOf = (row, fingerprint) => ({ transactionId: row.id, fingerprint, date: row.date, amountCents: -row.amount, scheduleId: row.scheduleId, cleared: row.cleared, familyId: row.parentId ?? row.id });
export function recurrenceEvents(snapshot, { identity, today, period = snapshot?.period, scope = DEFAULT_SCOPE, unitAssignments = [], knownBills = [], dataState = 'fresh' } = {}) {
  assertRecurrenceIdentity(identity,snapshot);
  if (dataState !== 'fresh' || snapshot.transactionMetadataVersion !== '1' || identity.timezone !== snapshot.timezone || identity.currency !== snapshot.currency || typeof snapshot.id !== 'string' || !snapshot.id || !Number.isFinite(Date.parse(snapshot.syncedAt))) invalid();
  try { if (typeof identity.timezone !== 'string' || !identity.timezone) invalid(); new Intl.DateTimeFormat('en',{timeZone:identity.timezone}).format(); } catch { invalid(); }
  boundedPeriod(period,today);
  if (period.start < calendarMonths(12,period.end).start) invalid();
  if (!Array.isArray(snapshot.transactions) || snapshot.transactions.length > MAX_ROWS || !Array.isArray(unitAssignments) || unitAssignments.length > MAX_ROWS || !Array.isArray(knownBills) || knownBills.length > 1000) invalid();
  for (const catalog of [snapshot.accounts,snapshot.categories,snapshot.payees]) {
    if (!Array.isArray(catalog) || catalog.length > MAX_ROWS || catalog.some(row => !validId(row.id)) || new Set(catalog.map(row => row.id)).size !== catalog.length) invalid();
  }
  const accountIds = new Set(snapshot.accounts.map(row => row.id));
  const mappings = new Map();
  for (const raw of knownBills) {
    const bill = validateRecurrenceBill(raw,identity);
    if (!bill.active) continue;
    const key = JSON.stringify([bill.payeeId,bill.accountId]), list = mappings.get(key) ?? [];
    list.push(bill); mappings.set(key,list);
  }
  const fingerprints = new Map();
  for (const row of snapshot.transactions) {
    if (fingerprints.has(row.id) || !validDate(row.date) || !accountIds.has(row.accountId)) invalid();
    fingerprints.set(row.id,recurrenceTransactionFingerprint(identity,row));
  }
  const analysis = analyzeSnapshot(snapshot,{period,scope,today});
  const rows = new Map(snapshot.transactions.map(row => [row.id,row]));
  const assignments = new Map(), unresolvedEvidence = [];
  for (const assignment of unitAssignments) {
    assertRecurrenceIdentity(identity,assignment);
    if (!validId(assignment.transactionId) || !validId(assignment.unitId) || !/^[a-f0-9]{64}$/.test(assignment.fingerprint) || assignments.has(assignment.transactionId)) invalid();
    assignments.set(assignment.transactionId,assignment);
    if (!rows.has(assignment.transactionId)) unresolvedEvidence.push({ reason:'assigned_transaction_not_in_snapshot', transactionIds:[assignment.transactionId], unitId:assignment.unitId });
  }
  const eligible = new Map(analysis.includedTransactions.filter(row => row.amount < 0 && !row.startingBalance &&
    analysis.payees.has(row.payeeId) && (row.categoryId === null || analysis.categories.has(row.categoryId)) && !analysis.categories.get(row.categoryId)?.isIncome).map(row => [row.id,row]));
  for (const row of analysis.includedTransactions) {
    if (row.amount < 0 && !row.startingBalance && (!analysis.payees.has(row.payeeId) || row.categoryId !== null && !analysis.categories.has(row.categoryId))) unresolvedEvidence.push({reason:'catalog_reference_missing',transactionIds:[row.id]});
  }
  const families = new Map();
  for (const row of snapshot.transactions) if (row.isChild || row.parentId) {
    const parent = rows.get(row.parentId);
    if (!parent?.isParent || parent.accountId !== row.accountId || parent.date !== row.date) invalid();
    const family = families.get(row.parentId) ?? []; family.push(row); families.set(row.parentId,family);
  }
  const events = [];
  const addEvent = (members, parent = null) => {
    const transactionIds = members.map(row => row.id), first = members[0];
    if (!members.every(row => eligible.has(row.id)) || parent && (parent.transferId || parent.startingBalance || analysis.payees.get(parent.payeeId)?.transferAccountId)) { if (parent) unresolvedEvidence.push({reason:'split_family_ineligible',transactionIds}); return; }
    const explicit = members.map(row => assignments.get(row.id));
    const stale = members.filter((row,i) => explicit[i] && explicit[i].fingerprint !== fingerprints.get(row.id));
    if (stale.length) { unresolvedEvidence.push({reason:'assignment_changed',transactionIds:stale.map(row => row.id)}); return; }
    const units = members.map((row,i) => {
      if (explicit[i]) return explicit[i];
      const bills = mappings.get(JSON.stringify([row.payeeId,row.accountId])) ?? [];
      const schedules = row.scheduleId === null ? [] : bills.filter(bill => bill.sourceScheduleId === row.scheduleId);
      const possible = new Set((schedules.length ? schedules : bills).map(bill => bill.unitId));
      return possible.size === 1 ? {unitId:[...possible][0]} : null;
    });
    if (units.some(unit => !unit)) { unresolvedEvidence.push({reason:'unit_required',transactionIds}); return; }
    if (members.some((row,i) => row.payeeId !== first.payeeId || row.accountId !== first.accountId || row.date !== first.date || units[i].unitId !== units[0].unitId)) {
      unresolvedEvidence.push({reason:'split_family_ambiguous',transactionIds}); return;
    }
    const total = members.reduce((sum,row) => sum - BigInt(row.amount),0n);
    if (total > BigInt(Number.MAX_SAFE_INTEGER) || parent && -BigInt(parent.amount) !== total) invalid();
    events.push({ eventId:parent?.id ?? first.id, unitId:units[0].unitId, payeeId:first.payeeId, accountId:first.accountId, date:first.date,
      amountCents:Number(total), evidence:members.map(row => evidenceOf(row,fingerprints.get(row.id))) });
  };
  for (const row of snapshot.transactions) {
    if (row.isParent) { const members = families.get(row.id); if (!members?.length) invalid(); addEvent(members,row); }
    else if (!row.isChild && !row.parentId && eligible.has(row.id)) addEvent([row]);
  }
  events.sort((a,b) => a.date.localeCompare(b.date) || a.eventId.localeCompare(b.eventId));
  return { events, rows, fingerprints, unresolvedEvidence, metadata:{...analysis.metadata,rulesVersion:RECURRENCE_RULES_VERSION,financeRulesVersion:analysis.metadata.rulesVersion,dataState:'fresh'} };
}
export function detectCandidates(snapshot, options = {}) {
  const { knownBills = [], minimumMonths = 3 } = options;
  if (!Array.isArray(knownBills) || knownBills.length > 1000 || minimumMonths !== 3) throw new AppError('INPUT_INVALID');
  const result = recurrenceEvents(snapshot,options), groups = new Map(), known = new Set();
  const keyOf = row => JSON.stringify([row.unitId,row.payeeId,row.accountId]);
  for (const bill of knownBills) {
    assertRecurrenceIdentity(options.identity,bill);
    if (!['unitId','payeeId','accountId'].every(key => validId(bill[key]))) throw new AppError('INPUT_INVALID');
    if (bill.active) known.add(keyOf(bill));
  }
  for (const event of result.events) { const key=keyOf(event), list=groups.get(key)??[]; list.push(event); groups.set(key,list); }
  const candidates = [], unresolvedEvidence = [...result.unresolvedEvidence];
  for (const [key,events] of groups) {
    if (known.has(key)) continue;
    const byMonth = new Map();
    for (const event of events) { const month=event.date.slice(0,7), list=byMonth.get(month)??[]; list.push(event); byMonth.set(month,list); }
    if ([...byMonth.values()].some(list => list.length > 1)) { unresolvedEvidence.push({reason:'multiple_events_in_month',unitId:events[0].unitId,payeeId:events[0].payeeId,accountId:events[0].accountId,transactionIds:events.flatMap(event => event.evidence.map(row => row.transactionId))}); continue; }
    const months = [...byMonth.keys()].sort(); let run=[], best=[];
    for (const month of months) { if (run.length && shiftMonth(run.at(-1),1) !== month) run=[]; run.push(month); if (run.length >= best.length) best=[...run]; }
    if (best.length < 3) continue;
    const support = best.map(month => byMonth.get(month)[0]), amounts = support.map(event => BigInt(event.amountCents)).sort((a,b)=>a<b?-1:a>b?1:0), middle=Math.floor(amounts.length/2);
    const suggestedAmountCents = Number(amounts.length%2 ? amounts[middle] : (amounts[middle-1]+amounts[middle]+1n)/2n);
    const id=recurrenceId('cand',[options.identity.householdId,options.identity.budgetId,...JSON.parse(key)]);
    candidates.push({id,key:id,householdId:options.identity.householdId,budgetId:options.identity.budgetId,unitId:events[0].unitId,payeeId:events[0].payeeId,accountId:events[0].accountId,
      months:best,evidence:support.flatMap(event => event.evidence),suggestedAmountCents,active:false,dateKind:'estimated',hypothesis:'monthly_posting_pattern_not_due_date',currentMonthPartial:best.includes(options.today.slice(0,7)),snapshotId:snapshot.id,syncedAt:snapshot.syncedAt});
  }
  return {candidates,unresolvedEvidence,metadata:result.metadata};
}
