import { AppError } from '../errors.mjs';
import { DEFAULT_REPORT_THRESHOLDS, validateReportThresholds } from './thresholds.mjs';
import { formatMoney } from '../finance/money.mjs';
import { label } from './render.mjs';

const KEY = 'report_preferences_v1';
const bad = () => { throw new AppError('INPUT_INVALID'); };
const canonicalThresholds = value => {
  const thresholds = validateReportThresholds(value);
  return { ...thresholds, lowBalances: [...thresholds.lowBalances].sort((a,b)=>a.accountId.localeCompare(b.accountId)) };
};
export function validTimezone(value) {
  if (typeof value !== 'string' || value.length > 100) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
}
export function defaultReportPreferences(config) {
  return { version: 1, dailyEnabled: false, alertsEnabled: false, timezone: config.timezone, days: [1,2,3,4,5,6,7], time: '08:00', detail: 'summary',
    thresholds: structuredClone(DEFAULT_REPORT_THRESHOLDS), dailySince: null, alertsSince: null, revision: 1, scheduleRevision: 1, alertsRevision: 1, updatedAt: null };
}
export function validateReportPreferences(value) {
  const keys = ['version','dailyEnabled','alertsEnabled','timezone','days','time','detail','thresholds','dailySince','alertsSince','revision','scheduleRevision','alertsRevision','updatedAt'];
  if (!value || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(value,k))) bad();
  if (value.version !== 1 || typeof value.dailyEnabled !== 'boolean' || typeof value.alertsEnabled !== 'boolean' || !validTimezone(value.timezone) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time) || !['summary','detailed'].includes(value.detail)) bad();
  if (!Array.isArray(value.days) || !value.days.length || value.days.length > 7 || new Set(value.days).size !== value.days.length || value.days.some(d => !Number.isSafeInteger(d) || d < 1 || d > 7)) bad();
  for (const k of ['revision','scheduleRevision','alertsRevision']) if (!Number.isSafeInteger(value[k]) || value[k] < 1) bad();
  for (const k of ['dailySince','alertsSince','updatedAt']) if (value[k] !== null && (!Number.isSafeInteger(value[k]) || value[k] < 0)) bad();
  if ((value.dailyEnabled && value.dailySince === null) || (value.alertsEnabled && value.alertsSince === null)) bad();
  return { ...value, days: [...value.days].sort((a,b) => a-b), thresholds: canonicalThresholds(value.thresholds) };
}

export class ReportPreferences {
  constructor({ config, store, now = () => store.now() }) { Object.assign(this,{config,store,now}); }
  get() {
    try { return validateReportPreferences(this.store.getPreference(KEY, defaultReportPreferences(this.config))); }
    catch { throw new AppError('CONFIG_INVALID'); }
  }
  cancelPending(kind) {
    const db = this.store.db, now = this.now();
    db.prepare("UPDATE jobs SET state='done',updated_at=? WHERE state='queued' AND id IN (SELECT job_id FROM report_occurrences WHERE kind=? AND state='pending')").run(now,kind);
    db.prepare("UPDATE report_occurrences SET state='cancelled',completed_at=? WHERE kind=? AND state='pending'").run(now,kind);
    db.prepare("UPDATE report_deliveries SET cancelled=1 WHERE kind=? AND outbox_id IN (SELECT id FROM outbox WHERE state='pending')").run(kind);
    db.prepare("UPDATE outbox SET state='failed',updated_at=? WHERE state='pending' AND id IN (SELECT outbox_id FROM report_deliveries WHERE kind=? AND cancelled=1)").run(now,kind);
  }
  update(patch, identity) {
    this.store.assertIdentity(identity);
    if (!patch || Array.isArray(patch) || Object.keys(patch).some(k => !['dailyEnabled','alertsEnabled','timezone','days','time','detail','thresholds'].includes(k))) bad();
    return this.store.transaction(() => {
      const old = this.get(), next = { ...old, ...patch };
      if (Array.isArray(next.days)) next.days = [...next.days].sort((a,b)=>a-b);
      next.thresholds = canonicalThresholds(next.thresholds);
      // Subscriptions begin now; replay of the same assignment is a no-op.
      const scheduleChanged = ['timezone','time','days','dailyEnabled'].some(k => JSON.stringify(old[k]) !== JSON.stringify(next[k]));
      const alertsChanged = ['alertsEnabled','thresholds'].some(k => JSON.stringify(old[k]) !== JSON.stringify(next[k]));
      if (JSON.stringify(old) === JSON.stringify(next)) return old;
      if (scheduleChanged) { next.scheduleRevision++; if (next.dailyEnabled) next.dailySince = this.now(); }
      if (alertsChanged) { next.alertsRevision++; if (!old.alertsEnabled && next.alertsEnabled) next.alertsSince = this.now(); }
      next.revision++; next.updatedAt = this.now();
      const validated = validateReportPreferences(next);
      this.store.setPreference(KEY,validated);
      if (scheduleChanged) this.cancelPending('daily');
      if (alertsChanged) this.cancelPending('alerts');
      return validated;
    });
  }
  scopeChanged() {
    this.store.transaction(() => {
      const next = this.get(); next.alertsRevision++; next.revision++; next.updatedAt = this.now();
      this.store.setPreference(KEY,next); this.cancelPending('alerts');
    });
  }
  command(args, identity) {
    this.store.assertIdentity(identity);
    if (!args.length) return this.get();
    const [rawKey,...values] = args, key = rawKey.toLowerCase();
    let patch;
    if (['relatorio','alertas'].includes(key)) {
      if (values.length !== 1 || !['ativar','desativar'].includes(values[0])) bad();
      patch = { [key === 'relatorio' ? 'dailyEnabled' : 'alertsEnabled']: values[0] === 'ativar' };
    } else if (key === 'fuso') { if (values.length !== 1) bad(); patch = { timezone: values[0] }; }
    else if (key === 'horario') { if (values.length !== 1) bad(); patch = { time: values[0] }; }
    else if (key === 'detalhe') { if (values.length !== 1 || !['resumido','detalhado'].includes(values[0])) bad(); patch = { detail: values[0] === 'resumido' ? 'summary' : 'detailed' }; }
    else if (key === 'dias') {
      if (values.length !== 1) bad();
      const names = { seg:1,ter:2,qua:3,qui:4,sex:5,sab:6,dom:7 };
      patch = { days: values[0] === 'todos' ? [1,2,3,4,5,6,7] : values[0].toLowerCase().split(',').map(d => names[d] ?? (/^[1-7]$/.test(d) ? Number(d) : NaN)) };
    } else {
      const thresholds = structuredClone(this.get().thresholds);
      const numbers = values.map(v => /^\d+(?:\.\d+)?$/.test(v) ? Number(v) : NaN);
      if (key === 'orcamento' && values.length === 3) [thresholds.budgetWarningPercent,thresholds.budgetCriticalPercent,thresholds.budgetResetMarginPercent] = numbers;
      else if (key === 'anomalia' && values.length === 3) [thresholds.anomalyMinimumCents,thresholds.anomalyMedianMultiplier,thresholds.anomalyMadMultiplier] = numbers;
      else if (key === 'margem_saldo' && values.length === 1) thresholds.lowBalanceResetMarginCents = numbers[0];
      else if (key === 'saldo' && values.length === 2 && /^[A-Za-z0-9_-]{1,128}$/.test(values[0])) {
        thresholds.lowBalances = thresholds.lowBalances.filter(row => row.accountId !== values[0]);
        if (values[1] !== 'desligar') {
          if (!/^-?\d+$/.test(values[1])) bad();
          thresholds.lowBalances.push({ accountId: values[0], limitCents: Number(values[1]) });
        }
      } else bad();
      patch = { thresholds };
    }
    return this.update(patch,identity);
  }
}

export function renderPreferences(p) {
  return `Relatório diário: ${p.dailyEnabled ? 'ativado' : 'desativado'}. Alertas periódicos: ${p.alertsEnabled ? 'ativados (a cada 15 minutos, todos os dias)' : 'desativados'}.\nAgenda: ${label(p.timezone)}, dias ISO ${p.days.join(',')} (1=seg,7=dom), ${p.time}; detalhe ${p.detail === 'summary' ? 'resumido' : 'detalhado'}. O fuso financeiro permanece o do orçamento.\nOrçamento: atenção ${p.thresholds.budgetWarningPercent}%, crítico ${p.thresholds.budgetCriticalPercent}%, margem ${p.thresholds.budgetResetMarginPercent} pontos percentuais.\nSaldo baixo por conta: ${p.thresholds.lowBalances.map(r => `${r.accountId}: ${formatMoney(r.limitCents)}`).join('; ') || 'desligado'}; margem ${formatMoney(p.thresholds.lowBalanceResetMarginCents)}.\nAnomalia: mínimo ${formatMoney(p.thresholds.anomalyMinimumCents)}, multiplicadores mediana/MAD ${p.thresholds.anomalyMedianMultiplier}/${p.thresholds.anomalyMadMultiplier}.\n/preferencias relatorio ativar|desativar\n/preferencias alertas ativar|desativar\n/preferencias fuso America/Sao_Paulo\n/preferencias dias seg,ter,qua,qui,sex\n/preferencias horario 08:00\n/preferencias detalhe resumido|detalhado\n/preferencias orcamento 80 100 5\n/preferencias saldo <accountId> <limite_em_centavos>|desligar\n/preferencias margem_saldo 1000\n/preferencias anomalia 5000 3 3\n/relatorio consulta agora, sem ativar a agenda.`;
}
