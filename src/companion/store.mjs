import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { validDate } from '../actual/snapshot.mjs';
import { localToday, normalizeText } from '../finance/periods.mjs';
import { safeHistoryText } from '../conversation/store.mjs';

export const MEMORY_KINDS = Object.freeze(['planned_purchase', 'classification_hint', 'financial_note']);
export const GOAL_METRICS = Object.freeze(['manual_savings_progress', 'category_spending_cap', 'account_balance']);
export const GOAL_STATUSES = Object.freeze(['active', 'paused', 'completed', 'cancelled']);
const MAX_CENTS = 1_000_000_000_000;
const KEYS = 'household_id=? AND budget_id=? AND user_id=? AND chat_id=?';
// Financial memories must stay factual. This deliberately rejects common
// profile/diagnosis labels even when a model calls the repository directly.
const PSYCHOLOGICAL_PROFILE = /\b(?:perfil|tracos?|carater|temperamento|psicologic(?:o|a)|comportamental|patolog(?:ia|ico|ica)|diagnostico|transtorno|compuls(?:ao|ivo|iva|ividade)|impulsiv(?:o|a|idade)|ansios(?:o|a|idade)|ansiedade|depress(?:ao|ivo|iva)|bipolar|tdah|adhd|autis(?:mo|ta)|viciad(?:o|a)|dependente\s+emocional|personalidade|irresponsavel|psicopat(?:a|ia)|mani(?:a|aco|aca)|obsess(?:ao|ivo|iva)|neurotic(?:o|a)|descontrolad(?:o|a)|incapaz|fraco|doente\s+mental|toc|borderline|narcis(?:ista|ismo)|esquiz(?:ofrenia|ofrenico|ofrenica)|trauma|fobia|emocionalmente|sou\s+gastador(?:a)?)\b/;
const id = prefix => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const validCompanionId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{12}$`).test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const inputHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function exactObject(value, keys, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new AppError('INPUT_INVALID');
}
function text(value, max, { optional = false } = {}) {
  if (optional && value == null) return null;
  if (typeof value !== 'string') throw new AppError('INPUT_INVALID');
  const clean = safeHistoryText(value).replace(/[\u202A-\u202E\u2066-\u2069]/g, '').trim().replace(/\s+/g, ' ');
  if (!clean || clean.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(clean)) throw new AppError('INPUT_INVALID');
  return clean;
}
function declaredText(value, max, options) {
  const clean = text(value, max, options);
  assertNoPsychologicalProfile(clean);
  return clean;
}
export function assertNoPsychologicalProfile(value) {
  if (value != null && PSYCHOLOGICAL_PROFILE.test(normalizeText(String(value).replace(/[\u202A-\u202E\u2066-\u2069]/g, '')))) throw new AppError('INPUT_INVALID');
}
function cents(value, { optional = false, zero = false } = {}) {
  if (optional && value == null) return null;
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > MAX_CENTS) throw new AppError('INPUT_INVALID');
  return value;
}
function date(value, { optional = false, minimum = null } = {}) {
  if (optional && value == null) return null;
  if (!validDate(value) || minimum && value < minimum) throw new AppError('INPUT_INVALID');
  return value;
}
function addDays(value, count) {
  const result = new Date(`${value}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + count);
  return result.toISOString().slice(0, 10);
}
function resultRow(row) {
  return row ? {
    id: row.id, kind: row.kind, status: row.status, subject: row.subject, note: row.note,
    merchantPattern: row.merchant_pattern, categoryName: row.category_name,
    expectedAmountCents: row.expected_amount_cents, plannedOn: row.planned_on,
    expiresOn: row.expires_on, createdAt: row.created_at, updatedAt: row.updated_at
  } : null;
}
function goalRow(row) {
  return row ? {
    id: row.id, title: row.title, metric: row.metric, status: row.status,
    targetCents: row.target_cents, currentCents: row.current_cents,
    categoryName: row.category_name, accountName: row.account_name,
    targetOn: row.target_on, createdAt: row.created_at, updatedAt: row.updated_at
  } : null;
}

export class CompanionStore {
  constructor(store, config, { now = () => new Date(store.now()) } = {}) {
    this.store = store;
    this.db = store.db;
    this.config = config;
    this.now = now;
    this.keys = [store.identity.householdId, store.identity.budgetId, store.identity.userId, store.identity.chatId];
    this.limits = { memoryDefaultTtlDays: 180, maxContextMemories: 12, maxContextGoals: 8, maxContextChars: 4000, ...config.companion };
  }
  assert(identity) { this.store.assertIdentity(identity); }
  today() { return localToday(this.config.timezone, this.now()); }
  expireMemories() {
    this.db.prepare(`UPDATE financial_memories SET status='expired',updated_at=? WHERE ${KEYS} AND status='active' AND expires_on<?`).run(this.store.now(), ...this.keys, this.today());
  }
  mutation(job, operation, operationKey, input, create) {
    if (!job?.id || typeof operation !== 'string' || typeof operationKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,170}$/.test(operationKey)) throw new AppError('INPUT_INVALID');
    const digest = inputHash(input);
    return this.store.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM companion_mutations WHERE source_job_id=? AND operation_key=?').get(job.id, operationKey);
      if (previous) {
        if ([previous.household_id, previous.budget_id, previous.user_id, previous.chat_id].some((value, index) => value !== this.keys[index])) throw new AppError('UNAUTHORIZED');
        if (previous.operation !== operation || previous.input_hash !== digest) throw new AppError('INPUT_INVALID');
        return JSON.parse(previous.result_json);
      }
      const persisted = this.db.prepare("SELECT payload FROM jobs WHERE id=? AND household_id=? AND state='running'").get(job.id, this.keys[0]);
      if (!persisted?.payload) throw new AppError('STORAGE_FAILED');
      let payload;
      try { payload = JSON.parse(persisted.payload); } catch { throw new AppError('STORAGE_FAILED'); }
      this.assert(payload.identity);
      const result = create();
      this.db.prepare('INSERT INTO companion_mutations VALUES (?,?,?,?,?,?,?,?,?,?)').run(job.id, operationKey, ...this.keys, operation, digest, JSON.stringify(result), this.store.now());
      return result;
    });
  }
  validateMemory(input) {
    exactObject(input, ['kind','subject','note','merchantPattern','categoryName','expectedAmountCents','plannedOn','expiresOn'], ['kind','subject']);
    if (!MEMORY_KINDS.includes(input.kind)) throw new AppError('INPUT_INVALID');
    const today = this.today(), plannedOn = date(input.plannedOn, { optional: true, minimum: today }), value = {
      kind: input.kind, subject: declaredText(input.subject, 200), note: declaredText(input.note, 600, { optional: true }),
      merchantPattern: declaredText(input.merchantPattern, 160, { optional: true }), categoryName: declaredText(input.categoryName, 160, { optional: true }),
      expectedAmountCents: cents(input.expectedAmountCents, { optional: true }), plannedOn,
      expiresOn: date(input.expiresOn ?? addDays(plannedOn ?? today, this.limits.memoryDefaultTtlDays), { minimum: today })
    };
    if (value.kind === 'classification_hint' && (!value.merchantPattern || !value.categoryName)) throw new AppError('INPUT_INVALID');
    if (value.kind === 'classification_hint' && (value.expectedAmountCents != null || value.plannedOn != null) || value.kind === 'planned_purchase' && value.merchantPattern != null || value.kind === 'financial_note' && (value.merchantPattern != null || value.categoryName != null || value.expectedAmountCents != null || value.plannedOn != null)) throw new AppError('INPUT_INVALID');
    if (value.plannedOn && value.expiresOn < value.plannedOn) throw new AppError('INPUT_INVALID');
    return value;
  }
  recordMemory(input, identity, job, operationKey = 'command') {
    this.assert(identity);
    const value = this.validateMemory(input);
    return this.mutation(job, 'record_memory', operationKey, value, () => {
      const memoryId = id('m'), now = this.store.now();
      this.db.prepare(`INSERT INTO financial_memories(id,household_id,budget_id,user_id,chat_id,kind,status,subject,note,merchant_pattern,category_name,expected_amount_cents,planned_on,expires_on,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?)`).run(memoryId, ...this.keys, value.kind, value.subject, value.note, value.merchantPattern, value.categoryName, value.expectedAmountCents, value.plannedOn, value.expiresOn, now, now);
      return { status: 'recorded', memory: resultRow(this.db.prepare(`SELECT * FROM financial_memories WHERE id=? AND ${KEYS}`).get(memoryId, ...this.keys)) };
    });
  }
  listMemories(identity, { includeInactive = false, limit = 50 } = {}) {
    this.assert(identity); this.expireMemories();
    if (typeof includeInactive !== 'boolean' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError('INPUT_INVALID');
    const rows = this.db.prepare(`SELECT * FROM financial_memories WHERE ${KEYS}${includeInactive ? '' : " AND status='active'"} ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'expired' THEN 1 ELSE 2 END,created_at DESC,rowid DESC LIMIT ?`).all(...this.keys, limit);
    return rows.map(resultRow);
  }
  cancelMemory(memoryId, identity, job, operationKey = 'command') {
    this.assert(identity);
    if (!validCompanionId(memoryId, 'm')) throw new AppError('INPUT_INVALID');
    return this.mutation(job, 'cancel_memory', operationKey, { memoryId }, () => {
      this.expireMemories();
      const row = this.db.prepare(`SELECT * FROM financial_memories WHERE id=? AND ${KEYS}`).get(memoryId, ...this.keys);
      if (!row) return { status: 'not_found' };
      if (row.status !== 'active') return { status: row.status, memory: resultRow(row) };
      const now = this.store.now();
      this.db.prepare(`UPDATE financial_memories SET status='cancelled',cancelled_at=?,updated_at=? WHERE id=? AND ${KEYS} AND status='active'`).run(now, now, memoryId, ...this.keys);
      return { status: 'cancelled', memory: resultRow(this.db.prepare(`SELECT * FROM financial_memories WHERE id=? AND ${KEYS}`).get(memoryId, ...this.keys)) };
    });
  }
  validateGoal(input) {
    exactObject(input, ['title','metric','targetCents','currentCents','categoryName','accountName','targetOn'], ['title','metric','targetCents']);
    if (!GOAL_METRICS.includes(input.metric)) throw new AppError('INPUT_INVALID');
    const today = this.today(), value = {
      title: declaredText(input.title, 160), metric: input.metric, targetCents: cents(input.targetCents),
      currentCents: input.metric === 'manual_savings_progress' ? cents(input.currentCents ?? 0, { zero: true }) : input.currentCents == null ? null : cents(input.currentCents, { zero: true }),
      categoryName: declaredText(input.categoryName, 160, { optional: true }), accountName: declaredText(input.accountName, 160, { optional: true }),
      targetOn: date(input.targetOn, { optional: true, minimum: today })
    };
    if (value.metric === 'manual_savings_progress' && (value.categoryName || value.accountName) || value.metric === 'category_spending_cap' && (!value.categoryName || value.accountName || value.currentCents != null) || value.metric === 'account_balance' && (!value.accountName || value.categoryName || value.currentCents != null)) throw new AppError('INPUT_INVALID');
    return value;
  }
  createGoal(input, identity, job, operationKey = 'command') {
    this.assert(identity);
    const value = this.validateGoal(input);
    const titleKey = normalizeText(value.title);
    return this.mutation(job, 'create_goal', operationKey, { ...value, titleKey }, () => {
      const existing = this.db.prepare(`SELECT * FROM financial_goals WHERE ${KEYS} AND title_key=? AND status IN ('active','paused')`).get(...this.keys, titleKey);
      if (existing) return { status: 'already_exists', goal: goalRow(existing) };
      const goalId = id('g'), now = this.store.now();
      this.db.prepare(`INSERT INTO financial_goals(id,household_id,budget_id,user_id,chat_id,title,title_key,metric,status,target_cents,current_cents,category_name,account_name,target_on,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?)`).run(goalId, ...this.keys, value.title, titleKey, value.metric, value.targetCents, value.currentCents, value.categoryName, value.accountName, value.targetOn, now, now);
      return { status: 'created', goal: goalRow(this.db.prepare(`SELECT * FROM financial_goals WHERE id=? AND ${KEYS}`).get(goalId, ...this.keys)) };
    });
  }
  findLiveGoal(title) {
    return this.db.prepare(`SELECT * FROM financial_goals WHERE ${KEYS} AND title_key=? AND status IN ('active','paused')`).get(...this.keys, normalizeText(text(title, 160)));
  }
  manageGoal(input, identity, job, operationKey = 'command') {
    this.assert(identity);
    const value = this.validateGoalMutation(input);
    if (value.action === 'create') {
      const { action: _action, ...goal } = value;
      return this.createGoal(goal, identity, job, operationKey);
    }
    const operations = { set_progress: 'set_goal_progress', add_progress: 'add_goal_progress', pause: 'pause_goal', resume: 'resume_goal', complete: 'complete_goal', cancel: 'cancel_goal' };
    return this.mutation(job, operations[value.action], operationKey, value, () => {
      const row = this.findLiveGoal(value.title);
      if (!row) return { status: 'not_found' };
      return this.updateGoal(row, value.action, value);
    });
  }
  validateGoalMutation(input) {
    exactObject(input, ['action','title','metric','targetCents','currentCents','amountCents','categoryName','accountName','targetOn'], ['action','title']);
    if (input.action === 'create') {
      if (input.amountCents !== undefined) throw new AppError('INPUT_INVALID');
      return { action: 'create', ...this.validateGoal({ title: input.title, metric: input.metric, targetCents: input.targetCents, currentCents: input.currentCents, categoryName: input.categoryName, accountName: input.accountName, targetOn: input.targetOn }) };
    }
    const operations = { set_progress: 'set_goal_progress', add_progress: 'add_goal_progress', pause: 'pause_goal', resume: 'resume_goal', complete: 'complete_goal', cancel: 'cancel_goal' };
    if (!Object.hasOwn(operations, input.action)) throw new AppError('INPUT_INVALID');
    const permitted = input.action === 'set_progress' ? ['action','title','currentCents'] : input.action === 'add_progress' ? ['action','title','amountCents'] : ['action','title'];
    if (Object.keys(input).some(key => !permitted.includes(key))) throw new AppError('INPUT_INVALID');
    const value = { action: input.action, title: declaredText(input.title, 160) };
    if (input.action === 'set_progress') value.currentCents = cents(input.currentCents, { zero: true });
    if (input.action === 'add_progress') value.amountCents = cents(input.amountCents);
    return value;
  }
  updateGoal(row, action, input = {}) {
    const now = this.store.now();
    if (['set_progress','add_progress'].includes(action)) {
      if (row.metric !== 'manual_savings_progress' || row.status !== 'active') return { status: 'invalid_transition', goal: goalRow(row) };
      const next = action === 'set_progress' ? cents(input.currentCents, { zero: true }) : cents(row.current_cents + cents(input.amountCents), { zero: true });
      this.db.prepare(`UPDATE financial_goals SET current_cents=?,updated_at=? WHERE id=? AND ${KEYS} AND status='active'`).run(next, now, row.id, ...this.keys);
      return { status: 'updated', goal: goalRow(this.db.prepare(`SELECT * FROM financial_goals WHERE id=? AND ${KEYS}`).get(row.id, ...this.keys)) };
    }
    const transitions = { pause: ['active','paused'], resume: ['paused','active'], complete: [null,'completed'], cancel: [null,'cancelled'] };
    const [required, target] = transitions[action] ?? [];
    if (!target || required && row.status !== required || !required && !['active','paused'].includes(row.status)) return { status: 'invalid_transition', goal: goalRow(row) };
    this.db.prepare(`UPDATE financial_goals SET status=?,updated_at=?,closed_at=? WHERE id=? AND ${KEYS}`).run(target, now, ['completed','cancelled'].includes(target) ? now : null, row.id, ...this.keys);
    return { status: target, goal: goalRow(this.db.prepare(`SELECT * FROM financial_goals WHERE id=? AND ${KEYS}`).get(row.id, ...this.keys)) };
  }
  transitionGoalById(goalId, action, identity, job, operationKey = 'command') {
    this.assert(identity);
    if (!validCompanionId(goalId, 'g') || !['pause','resume','complete','cancel'].includes(action)) throw new AppError('INPUT_INVALID');
    const operations = { pause: 'pause_goal', resume: 'resume_goal', complete: 'complete_goal', cancel: 'cancel_goal' };
    return this.mutation(job, operations[action], operationKey, { goalId, action }, () => {
      const row = this.db.prepare(`SELECT * FROM financial_goals WHERE id=? AND ${KEYS}`).get(goalId, ...this.keys);
      if (!row) return { status: 'not_found' };
      return this.updateGoal(row, action);
    });
  }
  listGoals(identity, { includeClosed = true, limit = 50 } = {}) {
    this.assert(identity);
    if (typeof includeClosed !== 'boolean' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError('INPUT_INVALID');
    const rows = this.db.prepare(`SELECT * FROM financial_goals WHERE ${KEYS}${includeClosed ? '' : " AND status IN ('active','paused')"} ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,created_at DESC,rowid DESC LIMIT ?`).all(...this.keys, limit);
    return rows.map(goalRow);
  }
  context(identity) {
    this.assert(identity);
    const memoryRows = this.listMemories(identity, { limit: Math.min(100, this.limits.maxContextMemories + 1) });
    const goalRows = this.listGoals(identity, { includeClosed: false, limit: Math.min(100, this.limits.maxContextGoals + 1) });
    const memories = memoryRows.slice(0, this.limits.maxContextMemories).map(({ id: _id, createdAt: _createdAt, updatedAt: _updatedAt, status: _status, ...row }) => row);
    const goals = goalRows.slice(0, this.limits.maxContextGoals).map(({ id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...row }) => row);
    const result = { asOf: this.today(), memories, goals, truncated: memoryRows.length > memories.length || goalRows.length > goals.length };
    while (Buffer.byteLength(JSON.stringify(result)) > this.limits.maxContextChars && (result.memories.length || result.goals.length)) {
      result.truncated = true;
      if (result.memories.length >= result.goals.length) result.memories.pop(); else result.goals.pop();
    }
    return result;
  }
}
