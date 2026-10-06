import { AppError } from '../errors.mjs';
import { validDate, validMonth } from '../actual/snapshot.mjs';
import { validId } from '../actual/transaction.mjs';
import { assertRecurrenceIdentity } from './calendar.mjs';
import { recurrenceEvents } from './detect.mjs';

export function evaluateVariation({referenceAmountCents,observedAmountCents,percent=20,minimumCents=2000}={}) {
  if (!Number.isSafeInteger(percent) || percent < 1 || percent > 1000 || !Number.isSafeInteger(minimumCents) || minimumCents < 0 ||
      !(referenceAmountCents === null || Number.isSafeInteger(referenceAmountCents) && referenceAmountCents >= 0) ||
      !(observedAmountCents === null || Number.isSafeInteger(observedAmountCents) && observedAmountCents >= 0)) throw new AppError('INPUT_INVALID');
  if (!referenceAmountCents || observedAmountCents === null) return {state:'insufficient_reference',changed:false,referenceAmountCents,observedAmountCents,percent,minimumCents};
  const reference=BigInt(referenceAmountCents),observed=BigInt(observedAmountCents),delta=observed-reference,absolute=delta<0n?-delta:delta;
  const changed=absolute>BigInt(minimumCents) && absolute*100n>reference*BigInt(percent);
  return {state:changed?'variation':'within_thresholds',changed,direction:delta>0n?'increase':delta<0n?'decrease':'unchanged',deltaCents:Number(delta),referenceAmountCents,observedAmountCents,percent,minimumCents};
}
function shiftDay(date,days) { const value=new Date(`${date}T12:00:00Z`);value.setUTCDate(value.getUTCDate()+days);const result=value.toISOString().slice(0,10);if(!validDate(result))throw new AppError('INPUT_INVALID');return result; }
const groupKey = row => JSON.stringify([row.unitId,row.payeeId,row.accountId]);
function eventsInWindow(events,start,end,limit=Infinity) {
  let low=0,high=events.length;
  while(low<high) { const middle=Math.floor((low+high)/2);if(events[middle].date<start)low=middle+1;else high=middle; }
  const selected=[];
  while(low<events.length&&events[low].date<=end&&selected.length<limit)selected.push(events[low++]);
  return selected;
}
export function matchOccurrences(occurrences,snapshot,options={}) {
  const {identity,today,dateWindowDays=7,previousMatches=[],dataState='fresh'}=options;
  assertRecurrenceIdentity(identity,snapshot);
  if (!Array.isArray(occurrences) || occurrences.length>12000 || !Array.isArray(previousMatches) || previousMatches.length>12000 || !validDate(today) || !Number.isSafeInteger(dateWindowDays) || dateWindowDays<0 || dateWindowDays>31 || !['fresh','stale'].includes(dataState)) throw new AppError('INPUT_INVALID');
  const ids=new Set();
  for(const row of occurrences) {
    assertRecurrenceIdentity(identity,row);
    if (!['id','billId','unitId','payeeId','accountId'].every(key=>validId(row[key])) || ids.has(row.id) || !validDate(row.dueDate) || !validMonth(row.competence) || !['confirmed','estimated'].includes(row.dateKind) || !['open','paid_manual','cancelled'].includes(row.localState) || !(row.sourceScheduleId===null||validId(row.sourceScheduleId))) throw new AppError('INPUT_INVALID');
    ids.add(row.id);
  }
  if(dataState==='stale')return {matches:occurrences.map(row=>({occurrenceId:row.id,state:'unknown',evidence:[],snapshotId:snapshot.id,syncedAt:snapshot.syncedAt,reasons:['stale_snapshot']})),unresolvedEvidence:[],revokedEvidence:[],metadata:{householdId:identity.householdId,budgetId:identity.budgetId,dataState:'stale'}};
  const result=recurrenceEvents(snapshot,options),groups=new Map(),choices=new Map(),claims=new Map(),matches=[];
  for(const event of result.events){const key=groupKey(event),list=groups.get(key)??[];list.push(event);groups.set(key,list);}
  const unresolvedRows = new Map();
  for (const unresolved of result.unresolvedEvidence) {
    for (const id of unresolved.transactionIds) {
      const row=result.rows.get(id);
      if(row)unresolvedRows.set(id,row);
    }
  }
  const unresolvedGroups=new Map();
  for(const row of unresolvedRows.values()) {
    const key=JSON.stringify([row.accountId,row.payeeId]),list=unresolvedGroups.get(key)??[];
    list.push(row);unresolvedGroups.set(key,list);
  }
  for(const list of unresolvedGroups.values())list.sort((a,b)=>a.date.localeCompare(b.date));
  let links=0;
  for(const row of occurrences){
    const start=shiftDay(row.dueDate,-dateWindowDays),end=shiftDay(row.dueDate,dateWindowDays),through=end>today?today:end;
    const match={occurrenceId:row.id,state:'none',evidence:[],snapshotId:snapshot.id,syncedAt:snapshot.syncedAt,reasons:[],criteria:{unitId:row.unitId,payeeId:row.payeeId,accountId:row.accountId,start,end,dateWindowDays}};
    matches.push(match);
    if(row.localState==='cancelled'){match.reasons.push('local_cancelled');continue;}
    if(start>today || snapshot.period.start>start || snapshot.period.end<through){match.state='unknown';match.reasons.push('window_not_covered');}
    if(eventsInWindow(unresolvedGroups.get(JSON.stringify([row.accountId,row.payeeId]))??[],start,through,1).length) {
      match.state='unknown';match.reasons.push('unit_or_family_unresolved');
    }
    // Even an incompletely covered occurrence can compete for a visible event;
    // its uncertainty must not let another occurrence claim that event alone.
    const events=eventsInWindow(groups.get(groupKey(row))??[],start,through);
    if((links+=events.reduce((count,event)=>count+event.evidence.length,0))>100000)throw new AppError('SNAPSHOT_INVALID');
    choices.set(row.id,events);
    for(const event of events){const list=claims.get(event.eventId)??[];list.push(row.id);claims.set(event.eventId,list);}
  }
  for(const match of matches){
    const events=choices.get(match.occurrenceId);if(!events?.length)continue;
    const disputed=events.some(event=>claims.get(event.eventId).length>1);
    if(match.state==='unknown')continue;
    match.state=events.length===1&&!disputed?'compatible':'ambiguous';
    match.evidence=events.flatMap(event=>event.evidence);
    match.observedAmountCents=match.state==='compatible'?events[0].amountCents:null;
    match.reasons.push(disputed?'transaction_claimed_by_multiple_occurrences':events.length>1?'multiple_compatible_events':'exact_unit_account_payee_date_window');
  }
  const revokedEvidence=[],currentMatches=new Map(matches.map(row=>[row.occurrenceId,row])),previousIds=new Set();let previousCount=0;
  for(const previous of previousMatches){
    if(!ids.has(previous.occurrenceId)||previousIds.has(previous.occurrenceId)||!Array.isArray(previous.evidence)||(previousCount+=previous.evidence.length)>100000)throw new AppError('INPUT_INVALID');
    previousIds.add(previous.occurrenceId);
    for(const evidence of previous.evidence){
      if(!validId(evidence.transactionId)||!validDate(evidence.date)||!/^[a-f0-9]{64}$/.test(evidence.fingerprint))throw new AppError('INPUT_INVALID');
      const current=result.rows.get(evidence.transactionId);
      if(current&&result.fingerprints.get(current.id)!==evidence.fingerprint)revokedEvidence.push({occurrenceId:previous.occurrenceId,transactionId:evidence.transactionId,reason:'transaction_changed'});
      else if(!current&&evidence.date>=snapshot.period.start&&evidence.date<=snapshot.period.end)revokedEvidence.push({occurrenceId:previous.occurrenceId,transactionId:evidence.transactionId,reason:'transaction_absent_in_covered_period'});
      else if(current&&currentMatches.get(previous.occurrenceId).state==='none'&&!currentMatches.get(previous.occurrenceId).reasons.includes('local_cancelled'))revokedEvidence.push({occurrenceId:previous.occurrenceId,transactionId:evidence.transactionId,reason:'no_longer_compatible'});
    }
  }
  return {matches,unresolvedEvidence:result.unresolvedEvidence,revokedEvidence,metadata:{...result.metadata,dateWindowDays}};
}
