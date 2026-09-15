import { createHash } from 'node:crypto';
import { badConfig } from '../config-diagnostics.mjs';

export const validTargetId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function validateCategorizationConfig(value = {}) {
  const bad = (field, reason) => badConfig('categorization' + (field ? '.' + field : ''), reason);
  if (!value || Array.isArray(value) || typeof value !== 'object') bad('', 'expected_object');
  if (Object.keys(value).some(k => k !== 'rules')) bad('', 'unknown_field');
  const rules = value.rules ?? [];
  if (!Array.isArray(rules) || rules.length > 100 || new Set(rules.map(r => r?.id)).size !== rules.length) bad('rules', 'invalid_rules');
  return Object.freeze({ rules: Object.freeze(rules.map(rule => {
    if (!rule || Array.isArray(rule) || typeof rule !== 'object') bad('rules', 'expected_object');
    if (Object.keys(rule).some(k => !['id','payeeId','accountId','categoryId'].includes(k))) bad('rules', 'unknown_field');
    for (const key of ['id', 'payeeId', 'categoryId']) if (!validTargetId(rule[key])) bad('rules.' + key, 'invalid_identifier');
    if (rule.accountId != null && !validTargetId(rule.accountId)) bad('rules.accountId', 'invalid_identifier');
    return Object.freeze({ id: rule.id, payeeId: rule.payeeId, accountId: rule.accountId ?? null, categoryId: rule.categoryId });
  })) });
}

// Exact local payee/account identity, never fuzzy text or an LLM-created ID.
export function featureKey(context, transaction) {
  if (!transaction.payeeId) return null;
  return createHash('sha256').update(JSON.stringify(['payee-account-v1', context.householdId, context.budgetId, transaction.accountId, transaction.payeeId])).digest('hex');
}
export function confidence(score, { source, conflict = false, count = 0, agreement = 0 }) {
  if (!conflict && score >= .95 && (source === 'rule' || (source === 'confirmed' && count >= 5 && agreement >= .9))) return 'alta';
  return score >= .7 ? 'média' : 'baixa';
}

export function recommendCategories({ inspection, rules = [], examples = [], history = [] }) {
  const tx = inspection.transaction;
  const catalog = new Map(inspection.categories.filter(c => !c.hidden && c.id !== tx.categoryId).map(c => [c.id, c]));
  const finish = (candidates, source, total, conflict = false) => candidates.slice(0, 3).map(({ categoryId, count, score, ruleIds }) => ({
    categoryId, name: catalog.get(categoryId).name, source, score,
    confidence: confidence(score, { source, conflict, count, agreement: total ? count / total : 0 }),
    evidence: { count, total, agreement: total ? count / total : null, conflict, ...(ruleIds ? { ruleIds } : {}) }
  }));
  const matched = rules.filter(r => r.payeeId === tx.payeeId && (r.accountId == null || r.accountId === tx.accountId));
  if (matched.length) {
    const groups = new Map();
    for (const r of matched) { if (!groups.has(r.categoryId)) groups.set(r.categoryId, []); groups.get(r.categoryId).push(r.id); }
    // A deleted/hidden rule destination or a second destination is a conflict.
    const conflict = groups.size !== 1 || [...groups.keys()].some(id => !catalog.has(id));
    const candidates = [...groups].filter(([id]) => catalog.has(id)).map(([categoryId, ruleIds]) => ({ categoryId, ruleIds, count: ruleIds.length, score: conflict ? .65 : 1 }));
    return finish(candidates, 'rule', matched.length, conflict);
  }
  const feature = featureKey(inspection.context, tx);
  if (!feature) return [];
  const confirmed = examples.filter(e => e.active === 1 && e.feature_key === feature && e.target_id !== tx.id);
  const ranked = (rows, source) => {
    const unique = [...new Map(rows.map(row => [row.targetId, row])).values()];
    const counts = new Map();
    for (const row of unique) if (catalog.has(row.categoryId)) counts.set(row.categoryId, (counts.get(row.categoryId) ?? 0) + 1);
    return finish([...counts].map(([categoryId, count]) => {
      const agreement = count / unique.length;
      const score = source === 'confirmed' ? (count >= 5 && agreement >= .9 ? .95 : Math.min(.89, .55 + .04 * count + .1 * agreement)) : Math.min(.8, .4 + .3 * agreement + Math.min(count, 10) * .01);
      return { categoryId, count, score };
    }).sort((a, b) => b.count - a.count || a.categoryId.localeCompare(b.categoryId)), source, unique.length, counts.size > 1);
  };
  if (confirmed.length) return ranked(confirmed.map(e => ({ targetId: e.target_id, categoryId: e.category_id })), 'confirmed');
  const past = history.filter(row => row.id !== tx.id && row.accountId === tx.accountId && row.payeeId === tx.payeeId && row.date <= tx.date && !row.isParent && !row.isChild && !row.parentId && !row.transferId && row.categoryId);
  return ranked(past.map(row => ({ targetId: row.id, categoryId: row.categoryId })), 'history');
}
