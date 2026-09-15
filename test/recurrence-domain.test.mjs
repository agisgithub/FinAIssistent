import test from 'node:test';
import assert from 'node:assert/strict';
import { financialSnapshot } from './fixtures/financial.mjs';
import { detectCandidates, recurrenceTransactionFingerprint } from '../src/recurrence/detect.mjs';
import { buildCalendar, deriveOccurrenceState, validateRecurrenceBill } from '../src/recurrence/calendar.mjs';
import { matchOccurrences, evaluateVariation } from '../src/recurrence/match.mjs';

const today='2026-09-15',period={start:'2025-10-01',end:today};
const identity={householdId:'home',budgetId:'synthetic-budget',timezone:'America/Sao_Paulo',currency:'BRL'};
const tx=(id,date,extra={})=>({id,date,amount:-10000,accountId:'checking',payeeId:'shop',categoryId:'food',notes:'Fictício',parentId:null,isParent:false,isChild:false,transferId:null,cleared:true,reconciled:true,startingBalance:false,scheduleId:null,...extra});
const snapshot=rows=>({...financialSnapshot(period),transactionMetadataVersion:'1',transactions:rows,budgetMonths:[]});
const assignment=(row,unitId='unit_a')=>({...identity,transactionId:row.id,unitId,fingerprint:recurrenceTransactionFingerprint(identity,row)});
const bill=(extra={})=>({id:'bill_a',...identity,unitId:'unit_a',name:'Luz "fictícia"\u202e /pago',payeeId:'shop',accountId:'checking',source:'manual',sourceScheduleId:null,startCompetence:'2025-10',endCompetence:null,dueDay:10,monthOffset:0,dateKind:'confirmed',dateSource:'user_confirmed',referenceAmountCents:10000,active:true,revision:1,...extra});
const months=()=>['06','07','08'].map(month=>tx(`tx_${month}`,`2026-${month}-10`));
const opts=rows=>({identity,today,period,unitAssignments:rows.filter(row=>!row.isParent).map(row=>assignment(row))});
const calendar=(bills=[bill()],extra={})=>buildCalendar(bills,{identity,from:'2026-09',to:'2026-09',today,timezone:identity.timezone,...extra});
const code=value=>error=>error.code===value;

test('three consecutive distinct months yield one inactive hypothesis with stable key, exact fingerprints and suggested median',()=>{
  const rows=months();rows[1].amount=-12000;const s=snapshot(rows),before=JSON.stringify(s);
  const result=detectCandidates(s,opts(rows));assert.equal(result.candidates.length,1);
  const candidate=result.candidates[0];assert.deepEqual(candidate.months,['2026-06','2026-07','2026-08']);assert.equal(candidate.suggestedAmountCents,10000);
  assert.equal(candidate.active,false);assert.equal(candidate.dateKind,'estimated');assert.match(candidate.hypothesis,/not_due_date/);
  assert.deepEqual(candidate.evidence.map(row=>row.fingerprint),rows.map(row=>recurrenceTransactionFingerprint(identity,row)));
  assert.equal(detectCandidates({...s,id:'new-snapshot'},opts(rows)).candidates[0].id,candidate.id);
  assert.equal(result.metadata.rulesVersion,'recurrence-1');assert.deepEqual(result.metadata.period,period);assert.equal(JSON.stringify(s),before);
});

test('two months, nonconsecutive months, same-month lines and duplicate imports cannot manufacture a monthly candidate',()=>{
  for(const rows of [months().slice(0,2),[tx('a','2026-01-10'),tx('b','2026-03-10'),tx('c','2026-05-10')],[tx('a','2026-06-01'),tx('b','2026-06-02'),tx('c','2026-06-03')]])assert.equal(detectCandidates(snapshot(rows),opts(rows)).candidates.length,0);
  const rows=months();rows.push({...rows[0],id:'duplicate_import'});
  const result=detectCandidates(snapshot(rows),opts(rows));assert.equal(result.candidates.length,0);assert.equal(result.unresolvedEvidence[0].reason,'multiple_events_in_month');
  assert.throws(()=>detectCandidates(snapshot([...months(),months()[0]]),opts(months())),code('SNAPSHOT_INVALID'));
});

test('unknown units, distinct accounts and distinct units remain separate, even with the same external name and amount',()=>{
  const rows=months();assert.equal(detectCandidates(snapshot(rows),{identity,today,period}).candidates.length,0);
  assert.equal(detectCandidates(snapshot(rows),{identity,today,period}).unresolvedEvidence.length,3);
  const units=opts(rows);units.unitAssignments[2].unitId='unit_b';assert.equal(detectCandidates(snapshot(rows),units).candidates.length,0);
  rows[2].accountId='card';assert.equal(detectCandidates(snapshot(rows),opts(rows)).candidates.length,0);
  const both=months().flatMap(row=>[row,{...row,id:row.id+'_b',accountId:'card'}]);
  assert.equal(detectCandidates(snapshot(both),opts(both)).candidates.length,2);
});

test('split components form at most one monthly family event and mixed units or transfers stay unresolved',()=>{
  const rows=months().flatMap(row=>[{...row,isParent:true}, {...row,id:row.id+'_1',isChild:true,parentId:row.id,amount:-4000}, {...row,id:row.id+'_2',isChild:true,parentId:row.id,amount:-6000}]);
  const result=detectCandidates(snapshot(rows),opts(rows));assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].suggestedAmountCents,10000);
  assert.equal(result.candidates[0].evidence.length,6);assert.equal(new Set(result.candidates[0].evidence.map(row=>row.familyId)).size,3);
  const mixed=opts(rows);mixed.unitAssignments[1].unitId='unit_b';assert.equal(detectCandidates(snapshot(rows),mixed).candidates.length,0);
  rows[0].transferId='transfer-id';assert.equal(detectCandidates(snapshot(rows),opts(rows)).candidates.length,0);
});

test('refunds, income reversals, transfers, opening balances and excluded accounts do not supply recurring expense history',()=>{
  for(const extra of [{amount:10000},{categoryId:'income'},{transferId:'x'},{payeeId:'transfer'},{startingBalance:true},{accountId:'off'},{accountId:'closed'}]) {
    const rows=months().map(row=>({...row,...extra}));assert.equal(detectCandidates(snapshot(rows),opts(rows)).candidates.length,0);
  }
  const rows=months().map(row=>({...row,accountId:'off'}));assert.equal(detectCandidates(snapshot(rows),{...opts(rows),scope:{includeClosed:false,includeOffBudget:true}}).candidates.length,1);
});

test('changed assignment never falls back to a confirmed pair mapping, and foreign assignments fail closed',()=>{
  const rows=months(),options={...opts(rows),knownBills:[bill()]};rows[0].amount=-11000;
  const result=detectCandidates(snapshot(rows),options);assert.ok(result.unresolvedEvidence.some(row=>row.reason==='assignment_changed'));
  options.unitAssignments[0].householdId='other';assert.throws(()=>detectCandidates(snapshot(rows),options),code('UNAUTHORIZED'));
});

test('fresh complete period identity and new snapshot fields are required for recurrence evidence',()=>{
  const rows=months();
  for(const mutate of [s=>{s.coverage.complete=false;},s=>{s.rulesVersion='2';},s=>{delete s.transactionMetadataVersion;},s=>{s.period.end='2026-09-14';},s=>{delete s.transactions[0].reconciled;},s=>{delete s.transactions[0].startingBalance;},s=>{delete s.transactions[0].scheduleId;},s=>{s.transactions[0].amount=1.1;},s=>{s.payees.push({...s.payees[0]});}]) {
    const s=snapshot(structuredClone(rows));mutate(s);assert.throws(()=>detectCandidates(s,opts(rows)),code('SNAPSHOT_INVALID'));
  }
  assert.throws(()=>detectCandidates({...snapshot(rows),budgetId:'other'},opts(rows)),code('UNAUTHORIZED'));
  assert.throws(()=>detectCandidates(snapshot(rows),{...opts(rows),dataState:'stale'}),code('SNAPSHOT_INVALID'));
});

test('calendar separates competence/offset, clamps February, restores31 and keeps stable IDs across edits and year rollover',()=>{
  const ordinary=calendar([bill({dueDay:31,monthOffset:1})],{from:'2026-01',to:'2026-02'}).occurrences;
  assert.deepEqual(ordinary.map(row=>[row.competence,row.dueDate,row.adjusted]),[['2026-01','2026-02-28',true],['2026-02','2026-03-31',false]]);
  const leap=calendar([bill({startCompetence:'2023-01',dueDay:31,monthOffset:1})],{from:'2024-01',to:'2024-01'}).occurrences[0];assert.equal(leap.dueDate,'2024-02-29');
  const rollover=calendar([bill({dueDay:31,monthOffset:1})],{from:'2026-12',to:'2026-12'}).occurrences[0];assert.equal(rollover.dueDate,'2027-01-31');
  const edited=calendar([bill({dueDay:20,monthOffset:0,revision:2})],{from:'2026-01',to:'2026-01'}).occurrences[0];assert.equal(edited.id,ordinary[0].id);assert.equal(edited.billRevision,2);
});

test('calendar boundaries, active dates and provenance are explicit; generated occurrences never infer payment',()=>{
  assert.equal(calendar([bill({active:false})]).occurrences.length,0);
  assert.equal(calendar([bill({endCompetence:'2026-08'})]).occurrences.length,0);
  const row=calendar([bill({dateKind:'estimated',dateSource:'user_estimate'})]).occurrences[0];assert.equal(row.dateKind,'estimated');assert.equal(row.localState,'open');assert.equal(row.name,bill().name);
  assert.throws(()=>calendar([bill()],{to:'2027-09'}),code('INPUT_INVALID'));
  assert.throws(()=>calendar([bill()],{timezone:undefined}),code('INPUT_INVALID'));
  assert.throws(()=>validateRecurrenceBill(bill({dateSource:'history_guess'}),identity),code('INPUT_INVALID'));
  assert.throws(()=>calendar([bill({budgetId:'wrong'})]),code('UNAUTHORIZED'));
});

test('derived state distinguishes estimated date passed, overdue without payment confirmation and explicit local terminal facts',()=>{
  const row=calendar().occurrences[0];
  assert.deepEqual(deriveOccurrenceState(row,{today,matchState:'compatible'}),{state:'overdue',paymentConfirmed:false,estimatedDatePassed:false,documentStatus:'unverified'});
  assert.equal(deriveOccurrenceState({...row,dateKind:'estimated'},{today}).state,'planned');
  assert.equal(deriveOccurrenceState({...row,dateKind:'estimated'},{today,matchState:'compatible'}).state,'compatible');
  assert.equal(deriveOccurrenceState({...row,dateKind:'estimated'},{today}).estimatedDatePassed,true);
  assert.equal(deriveOccurrenceState({...row,localState:'paid_manual'},{today}).state,'paid_manual');
  assert.equal(deriveOccurrenceState({...row,localState:'cancelled'},{today}).state,'cancelled');
});

test('exact assigned event with cleared/reconciled/schedule flags is compatible, never paid',()=>{
  const rows=[tx('expense','2026-09-10',{scheduleId:'sdk_schedule'})],occurrences=calendar().occurrences;
  const match=matchOccurrences(occurrences,snapshot(rows),opts(rows)).matches[0];
  assert.equal(match.state,'compatible');assert.equal(match.observedAmountCents,10000);assert.equal(match.evidence[0].cleared,true);assert.equal(match.evidence[0].scheduleId,'sdk_schedule');assert.equal(Object.hasOwn(match,'paidAt'),false);
  assert.equal(deriveOccurrenceState(occurrences[0],{today,matchState:match.state}).paymentConfirmed,false);
});

test('confirmed unique pair maps future events; two units require assignment or exact confirmed schedule mapping',()=>{
  const rows=[tx('expense','2026-09-10')],s=snapshot(rows),a=bill(),b=bill({id:'bill_b',unitId:'unit_b'});
  assert.equal(matchOccurrences(calendar([a]).occurrences,s,{identity,today,period,knownBills:[a]}).matches[0].state,'compatible');
  const ambiguous=matchOccurrences(calendar([a,b]).occurrences,s,{identity,today,period,knownBills:[a,b]});assert.ok(ambiguous.matches.every(row=>row.state==='unknown'));
  rows[0].scheduleId='schedule_a';a.sourceScheduleId='schedule_a';
  const separated=matchOccurrences(calendar([a,b]).occurrences,s,{identity,today,period,knownBills:[a,b]});assert.deepEqual(separated.matches.map(row=>row.state).sort(),['compatible','none']);
  const assigned=matchOccurrences(calendar([a,b]).occurrences,s,{...opts(rows),knownBills:[a,b]});assert.equal(assigned.matches.filter(row=>row.state==='compatible').length,1);
});

test('one transaction competing between occurrences, or two events for one occurrence, remains ambiguous',()=>{
  const rows=[tx('expense','2026-09-10')],bills=[bill(),bill({id:'second'})];
  const disputed=matchOccurrences(calendar(bills).occurrences,snapshot(rows),{identity,today,period,knownBills:bills});assert.ok(disputed.matches.every(row=>row.state==='ambiguous'));assert.ok(disputed.matches.every(row=>row.observedAmountCents===null));
  rows.push(tx('expense_two','2026-09-11'));assert.equal(matchOccurrences(calendar().occurrences,snapshot(rows),opts(rows)).matches[0].state,'ambiguous');
});

test('matching respects exact unit/account and date window, not names or amount similarity',()=>{
  const rows=[tx('expense','2026-09-10',{accountId:'card'})];assert.equal(matchOccurrences(calendar().occurrences,snapshot(rows),opts(rows)).matches[0].state,'none');
  rows[0].accountId='checking';rows[0].date='2026-08-20';assert.equal(matchOccurrences(calendar().occurrences,snapshot(rows),opts(rows)).matches[0].state,'none');
  rows[0].date='2026-09-10';rows[0].amount=-50000;assert.equal(matchOccurrences(calendar().occurrences,snapshot(rows),opts(rows)).matches[0].state,'compatible');
  const other=opts(rows);other.unitAssignments[0].unitId='unit_b';assert.equal(matchOccurrences(calendar().occurrences,snapshot(rows),other).matches[0].state,'none');
});

test('retroactive edits revoke old fingerprints, stale assignments block promotion and fresh reassignment recomputes evidence',()=>{
  const rows=[tx('expense','2026-09-10')],occurrences=calendar().occurrences,options=opts(rows),prior=matchOccurrences(occurrences,snapshot(rows),options).matches;
  rows[0].amount=-14000;
  const changed=matchOccurrences(occurrences,snapshot(rows),{...options,knownBills:[bill()],previousMatches:prior});assert.equal(changed.matches[0].state,'unknown');assert.equal(changed.revokedEvidence[0].reason,'transaction_changed');
  const refreshed=matchOccurrences(occurrences,snapshot(rows),{...opts(rows),previousMatches:prior});assert.equal(refreshed.matches[0].state,'compatible');assert.equal(refreshed.matches[0].observedAmountCents,14000);
  rows[0].date='2026-08-10';const redated=matchOccurrences(occurrences,snapshot(rows),{...opts(rows),previousMatches:prior});assert.equal(redated.matches[0].state,'none');assert.equal(redated.revokedEvidence[0].reason,'transaction_changed');
});

test('deletion only revokes covered observations; incomplete windows and stale cache never promote matches or undo manual payment',()=>{
  const rows=[tx('expense','2026-09-10')],occurrences=calendar().occurrences,prior=matchOccurrences(occurrences,snapshot(rows),opts(rows)).matches;
  const deleted=matchOccurrences(occurrences,snapshot([]),{identity,today,period,previousMatches:prior});assert.equal(deleted.matches[0].state,'none');assert.equal(deleted.revokedEvidence[0].reason,'transaction_absent_in_covered_period');
  const later={...snapshot([]),period:{start:'2026-09-12',end:today}};
  const unknown=matchOccurrences(occurrences,later,{identity,today,period:later.period,previousMatches:prior});assert.equal(unknown.matches[0].state,'unknown');assert.equal(unknown.revokedEvidence.length,0);
  const old=snapshot(rows);delete old.transactions[0].scheduleId;
  assert.equal(matchOccurrences(occurrences,old,{identity,today,dataState:'stale'}).matches[0].state,'unknown');
  assert.equal(deriveOccurrenceState({...occurrences[0],localState:'paid_manual'},{today,matchState:deleted.matches[0].state}).paymentConfirmed,true);
});

test('variation requires both strict percent and strict cents thresholds, with increase/decrease and configurable bounds',()=>{
  for(const [reference,observed,changed] of [[10000,12000,false],[10000,12001,true],[20000,23000,false],[5000,6500,false],[10000,8000,false],[10000,7999,true]])assert.equal(evaluateVariation({referenceAmountCents:reference,observedAmountCents:observed}).changed,changed);
  assert.equal(evaluateVariation({referenceAmountCents:10000,observedAmountCents:7999}).direction,'decrease');
  assert.equal(evaluateVariation({referenceAmountCents:10000,observedAmountCents:11501,percent:10,minimumCents:1500}).changed,true);
  assert.equal(evaluateVariation({referenceAmountCents:10000,observedAmountCents:11000,percent:10,minimumCents:0}).changed,false);
});

test('variation never invents missing/zero reference percentages and preserves integer cents at both extremes',()=>{
  for(const reference of [null,0])assert.equal(evaluateVariation({referenceAmountCents:reference,observedAmountCents:10000}).state,'insufficient_reference');
  assert.equal(evaluateVariation({referenceAmountCents:10000,observedAmountCents:null}).changed,false);
  const largest=Number.MAX_SAFE_INTEGER;
  const up=evaluateVariation({referenceAmountCents:1,observedAmountCents:largest});assert.equal(up.deltaCents,largest-1);assert.equal(up.changed,true);
  const down=evaluateVariation({referenceAmountCents:largest,observedAmountCents:0});assert.equal(down.deltaCents,-largest);assert.equal(down.changed,true);
  assert.throws(()=>evaluateVariation({referenceAmountCents:1.5,observedAmountCents:2}),code('INPUT_INVALID'));
  assert.throws(()=>evaluateVariation({referenceAmountCents:100,observedAmountCents:200,percent:0}),code('INPUT_INVALID'));
});

test('account/payee reassignments and source flag changes invalidate the full evidence fingerprint',()=>{
  const row=tx('expense','2026-09-10'),before=recurrenceTransactionFingerprint(identity,row);
  for(const patch of [{accountId:'card'},{payeeId:'different_payee'},{notes:'edited'},{cleared:false},{reconciled:false},{startingBalance:true},{scheduleId:'new_schedule'},{categoryId:'transport'}])assert.notEqual(recurrenceTransactionFingerprint(identity,{...row,...patch}),before);
  assert.throws(()=>recurrenceTransactionFingerprint(identity,{...row,scheduleId:undefined}),code('SNAPSHOT_INVALID'));
  assert.throws(()=>recurrenceTransactionFingerprint(identity,{...row,isChild:true}),code('SNAPSHOT_INVALID'));
});

test('a partially covered competing occurrence cannot permit a false exclusive match',()=>{
  const rows=[tx('expense','2026-09-10')],s={...snapshot(rows),period:{start:'2026-09-05',end:today}};
  const occurrences=calendar([bill(),bill({id:'second',dueDay:12})]).occurrences;
  const result=matchOccurrences(occurrences,s,{...opts(rows),period:s.period});
  assert.deepEqual(result.matches.map(row=>row.state).sort(),['ambiguous','unknown']);
});

test('split match exposes one observed total with component evidence and never counts the parent twice',()=>{
  const rows=[tx('parent','2026-09-10',{isParent:true}),tx('child1','2026-09-10',{isChild:true,parentId:'parent',amount:-3000}),tx('child2','2026-09-10',{isChild:true,parentId:'parent',amount:-7000})];
  const result=matchOccurrences(calendar().occurrences,snapshot(rows),opts(rows)).matches[0];assert.equal(result.state,'compatible');assert.equal(result.observedAmountCents,10000);assert.deepEqual(result.evidence.map(row=>row.transactionId).sort(),['child1','child2']);
});

test('outdated assignment cannot be silently rebound by a schedule mapping or another bill',()=>{
  const rows=[tx('expense','2026-09-10',{scheduleId:'sdk_schedule'})],options=opts(rows);rows[0].reconciled=false;
  const a=bill({sourceScheduleId:'sdk_schedule'}),b=bill({id:'bill_b',unitId:'unit_b'});
  const result=matchOccurrences(calendar([a,b]).occurrences,snapshot(rows),{...options,knownBills:[a,b]});assert.ok(result.matches.every(row=>row.state==='unknown'));
});

test('record and monetary bounds fail rather than truncate candidate aggregation or invent safe totals',()=>{
  const rows=months().map(row=>({...row,amount:-Number.MAX_SAFE_INTEGER}));assert.throws(()=>detectCandidates(snapshot(rows),opts(rows)),code('SNAPSHOT_INVALID'));
  const old={...snapshot(months()),period:{start:'2025-01-01',end:today}};assert.throws(()=>detectCandidates(old,{...opts(months()),period:old.period}),code('SNAPSHOT_INVALID'));
  assert.throws(()=>detectCandidates(snapshot([]),{identity,today,knownBills:Array.from({length:1001},()=>bill())}),code('INPUT_INVALID'));
  assert.throws(()=>matchOccurrences([],snapshot([]),{identity,today,dateWindowDays:32}),code('INPUT_INVALID'));
});

test('effective historical unit changes preserve ambiguity instead of rebinding old expenses to the latest unit',()=>{
  const rows=[tx('expense','2026-09-10')],a=bill(),futureB=bill({unitId:'unit_b',revision:2});
  const occurrenceA=calendar([a]).occurrences,occurrenceB=calendar([futureB]).occurrences;
  // Until effectiveFrom, the application supplies only A as a confirmed mapping.
  assert.equal(matchOccurrences(occurrenceA,snapshot(rows),{identity,today,period,knownBills:[a]}).matches[0].state,'compatible');
  // Once B becomes effective, both historical mappings remain in the catalog.
  for(const occurrences of [occurrenceA,occurrenceB])assert.equal(matchOccurrences(occurrences,snapshot(rows),{identity,today,period,knownBills:[a,futureB]}).matches[0].state,'unknown');
  const confirmed=matchOccurrences(occurrenceA,snapshot(rows),{...opts(rows),knownBills:[a,futureB]});assert.equal(confirmed.matches[0].state,'compatible');
  assert.equal(matchOccurrences(occurrenceB,snapshot(rows),{...opts(rows),knownBills:[a,futureB]}).matches[0].state,'none');
});
