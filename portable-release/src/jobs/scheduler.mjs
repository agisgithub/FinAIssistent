import { AppError,errorCode } from '../errors.mjs';
import { ReportPreferences,renderPreferences } from '../reports/preferences.mjs';
import { buildDailyReport,dailyReportPeriod } from '../reports/daily.mjs';
import { identityFromConfig } from '../policy/authorize.mjs';
import { DEFAULT_SCOPE,validateScope } from '../finance/analyze.mjs';
import { localToday } from '../finance/periods.mjs';
import { label,displayDate,displayTime } from '../reports/render.mjs';
import { withActionMetadata } from '../categorization/response.mjs';
import { latestDailyOccurrence } from './civil-time.mjs';
import { ReportStore } from './report-store.mjs';

export const ALERT_INTERVAL_MS=15*60*1000;
export class ReportScheduler {
  constructor({config,store,actual,now=()=>store.now(),buildReport=buildDailyReport,reportPeriod=dailyReportPeriod,upcomingProvider=()=>({available:false,items:[]})}) {
    Object.assign(this,{config,store,actual,now,buildReport,reportPeriod,upcomingProvider});
    this.preferences=new ReportPreferences({config,store,now}); this.repository=new ReportStore(store); this.identity=identityFromConfig(config);
  }
  scope() { return validateScope(this.store.getPreference('finance_scope',DEFAULT_SCOPE)); }
  tick() {
    const prefs=this.preferences.get(),now=this.now(),signature=`${Math.floor(now/60000)}:${prefs.revision}`;
    if (signature===this.lastTickSignature) return [];
    const daily=latestDailyOccurrence(prefs,now),result=[];
    if (daily) result.push(this.repository.reserve('daily',{key:daily.civilDate,instant:daily.instant,reportDate:localToday(this.config.timezone,new Date(daily.instant))},prefs));
    const instant=Math.floor(now/ALERT_INTERVAL_MS)*ALERT_INTERVAL_MS;
    if (prefs.alertsEnabled&&instant>=prefs.alertsSince) result.push(this.repository.reserve('alerts',{key:String(instant),instant,reportDate:localToday(this.config.timezone,new Date(instant))},prefs));
    this.lastTickSignature=signature;
    return result.filter(Boolean);
  }
  owns(job) { return ['daily_report','alert_scan'].includes(job.kind); }
  authorized(occurrence) {
    const prefs=this.preferences.get();
    return occurrence.state==='pending'&&(occurrence.kind==='daily'?prefs.dailyEnabled&&prefs.scheduleRevision===occurrence.policy_revision:prefs.alertsEnabled&&prefs.alertsRevision===occurrence.policy_revision);
  }
  authorizeDelivery(row) {
    const delivery=this.store.db.prepare('SELECT * FROM report_deliveries WHERE outbox_id=?').get(row.id);
    if (!delivery) return true;
    const prefs=this.preferences.get();
    if (delivery.kind==='daily') {
      const occurrence=this.store.db.prepare('SELECT scheduled_at FROM report_occurrences WHERE id=?').get(delivery.occurrence_id);
      const latest=latestDailyOccurrence(prefs,this.now());
      if (!occurrence || (latest && occurrence.scheduled_at<latest.instant)) return false;
    }
    if (delivery.alert_state_key) {
      const state=this.store.db.prepare('SELECT severity,transition_index FROM alert_state WHERE state_key=?').get(delivery.alert_state_key);
      if (!state||state.severity==='none'||state.transition_index!==delivery.alert_transition_index) return false;
    }
    return !delivery.cancelled && delivery.scope_json===JSON.stringify(this.scope()) && (delivery.kind==='daily'?prefs.dailyEnabled&&prefs.scheduleRevision===delivery.policy_revision:prefs.alertsEnabled&&prefs.alertsRevision===delivery.policy_revision);
  }
  checkSnapshot(snapshot,period) {
    if (snapshot?.householdId!==this.config.householdId||snapshot?.budgetId!==this.config.actual.budgetId||snapshot?.timezone!==this.config.timezone||snapshot?.currency!==this.config.currency) throw new AppError('UNAUTHORIZED');
    if (snapshot.period?.start!==period.start||snapshot.period?.end!==period.end||snapshot.rulesVersion!=='1') throw new AppError('SNAPSHOT_INVALID');
  }
  async read(reportDate,scope) {
    const period=this.reportPeriod(reportDate);
    let snapshot;
    try {
      snapshot=await this.actual.snapshot(period);
    } catch(error) {
      const code=errorCode(error,'ACTUAL_FAILED');
      if (!['ACTUAL_FAILED','ACTUAL_SYNC_FAILED','ACTUAL_TIMEOUT','NETWORK_FAILED'].includes(code)) throw error;
      const cached=this.store.db.prepare(`SELECT payload FROM snapshots WHERE household_id=? AND budget_id=?
        AND json_extract(payload,'$.period.start')=? AND json_extract(payload,'$.period.end')=?
        AND json_extract(payload,'$.timezone')=? AND json_extract(payload,'$.currency')=? AND json_extract(payload,'$.rulesVersion')='1'
        AND json_extract(payload,'$.coverage.complete')=1 AND json_array_length(payload,'$.coverage.failedAccountIds')=0
        AND json_extract(payload,'$.queryScope.includeClosed')=? AND json_extract(payload,'$.queryScope.includeOffBudget')=?
        ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(this.config.householdId,this.config.actual.budgetId,period.start,period.end,this.config.timezone,this.config.currency,scope.includeClosed?1:0,scope.includeOffBudget?1:0);
      return {snapshot:cached?JSON.parse(cached.payload):null,dataState:cached?'stale':'unavailable',code};
    }
    this.checkSnapshot(snapshot,period);
    if (snapshot.coverage?.complete!==true || snapshot.coverage.failedAccountIds?.length!==0) return {snapshot:null,dataState:'incomplete',code:'SNAPSHOT_INVALID'};
    this.store.saveSnapshot({...snapshot,queryScope:scope});
    return {snapshot,dataState:'fresh',code:null};
  }
  render(snapshot,{reportDate,scope,dataState,prefs}) {
    const upcoming=this.upcomingProvider({from:reportDate,to:new Date(Date.parse(reportDate+'T12:00:00Z')+7*86400000).toISOString().slice(0,10)});
    return this.buildReport(snapshot,{reportDate,today:localToday(this.config.timezone,new Date(this.now())),scope,dataState,detail:prefs.detail,thresholds:prefs.thresholds,identity:this.identity,trackedAlerts:this.repository.trackedAlerts(snapshot),upcoming});
  }
  unavailable(reportDate,dataState,code,durationMs) {
    return withActionMetadata({text:`Relatório de ${displayDate(reportDate)} indisponível: ${dataState==='incomplete'?'leitura incompleta':'Actual indisponível e sem snapshot compatível'}. Nenhum total foi calculado. Código: ${code}.`},{reason:'daily_report',durationMs,failure:code});
  }
  async runJob(job) {
    this.tick();
    const start=performance.now(),duration=()=>Math.max(0,Math.round(performance.now()-start)),occurrence=this.repository.occurrence(job);
    if (!this.authorized(occurrence)) { this.repository.cancel(job); return; }
    const scope=this.scope();
    try {
    const read=await this.read(occurrence.report_date,scope);
    this.tick();
    // A preference may be changed while the SDK call is pending. Never commit
    // old-policy delivery or alert state after unsubscribe/limit/scope change.
    if (!this.authorized(this.repository.occurrence(job))||JSON.stringify(this.scope())!==JSON.stringify(scope)) { this.repository.cancel(job); return; }
    const prefs=this.preferences.get();
    if (!read.snapshot) {
      this.repository.complete(job,occurrence,{state:'unavailable',dataState:read.dataState,scope,code:read.code,messages:occurrence.kind==='daily'?[this.unavailable(occurrence.report_date,read.dataState,read.code,duration())]:[]}); return;
    }
    const report=this.render(read.snapshot,{reportDate:occurrence.report_date,scope,dataState:read.dataState,prefs});
    const message=withActionMetadata({text:`Agendado para ${displayTime(occurrence.scheduled_at,this.config.timezone)}.\nData financeira: ${displayDate(occurrence.report_date)}.\n\n${report.text}`},{reason:'daily_report',durationMs:duration(),failure:read.code});
    this.repository.complete(job,occurrence,{state:read.dataState==='fresh'?'completed':'unavailable',snapshotId:read.snapshot.id,dataState:read.dataState,scope,code:read.code,
      messages:occurrence.kind==='daily'?[message]:[],candidates:occurrence.kind==='alerts'&&read.dataState==='fresh'?report.alertCandidates.map(c=>({...c,text:`${c.text}\n\nFonte: Actual · sincronizado em ${displayTime(read.snapshot.syncedAt,this.config.timezone)}.\nCompetência: ${label(c.competence)}.`})):null,durationMs:duration()});
    } catch (error) {
      if (this.store.db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id)?.state==='done') return;
      const code=errorCode(error); this.tick();
      this.store.transaction(()=>{
        const current=this.repository.occurrence(job);
        if (!this.authorized(current)||JSON.stringify(this.scope())!==JSON.stringify(scope)) this.repository.cancel(job);
        else this.repository.complete(job,current,{state:'unavailable',dataState:'unavailable',scope,messages:current.kind==='daily'?[withActionMetadata({text:`Relatório de ${current.report_date} indisponível. Nenhum total foi calculado. Código: ${code}.`},{reason:'daily_report',durationMs:duration(),failure:code})]:[]});
        this.store.db.prepare('UPDATE jobs SET error_code=? WHERE id=?').run(code,job.id);
      });
    }
  }
  async manualReport(identity) {
    this.store.assertIdentity(identity); const start=performance.now(),reportDate=localToday(this.config.timezone,new Date(this.now())),scope=this.scope(),read=await this.read(reportDate,scope);
    if (!read.snapshot) return this.unavailable(reportDate,read.dataState,read.code,Math.max(0,Math.round(performance.now()-start)));
    const report=this.render(read.snapshot,{reportDate,scope,dataState:read.dataState,prefs:this.preferences.get()});
    return withActionMetadata({text:report.text},{reason:'daily_report',durationMs:Math.max(0,Math.round(performance.now()-start)),failure:read.code});
  }
  async configure(args,identity) {
    this.store.assertIdentity(identity); const start=performance.now();
    if (args[0]?.toLowerCase()==='saldo'&&args.length===3&&args[2]!=='desligar') {
      const today=localToday(this.config.timezone,new Date(this.now())),period={start:today,end:today};
      const snapshot=await this.actual.snapshot(period); this.checkSnapshot(snapshot,period);
      if (!snapshot.accounts.some(account=>account.id===args[1])) return withActionMetadata({text:`Conta ${label(args[1])} não encontrada no catálogo Actual. Nenhum limite foi alterado. Consulte /contas e copie o ID exato.`},{reason:'report_preferences',durationMs:Math.max(0,Math.round(performance.now()-start)),failure:'INPUT_INVALID'});
    }
    return withActionMetadata({text:renderPreferences(this.preferences.command(args,identity))},{reason:'report_preferences',durationMs:Math.max(0,Math.round(performance.now()-start))});
  }
  prune(days){this.repository.prune(days);}
}
