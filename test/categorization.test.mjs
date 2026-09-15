import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { AppError } from '../src/errors.mjs';
import { StateStore } from '../src/storage/store.mjs';
import { identityFromConfig } from '../src/policy/authorize.mjs';
import { CategorizationActions } from '../src/application/actions.mjs';
import { createCommandHandler } from '../src/telegram/commands.mjs';
import { transactionFingerprint } from '../src/actual/transaction.mjs';
import { featureKey, recommendCategories } from '../src/categorization/recommend.mjs';
import { processOneJob, processOneDelivery } from '../src/jobs/runtime.mjs';
import { withActionMetadata } from '../src/categorization/response.mjs';
import { inputConfig, tempDirectory } from './helpers.mjs';

const category = (id, name = id) => ({ id, name, groupId: 'daily', isIncome: false, hidden: false });
const backupReference = (kind, operationId) => ({ id: randomUUID(), kind, operationId, createdAt: '2026-09-15T12:00:00Z', sha256: 'a'.repeat(64), bytes: 512 });
const initialTransaction = () => ({ id: 'TxCaseSensitive', accountId: 'Account', date: '2026-09-12', amount: -3250, payeeId: 'Payee', notes: 'synthetic financial note', categoryId: null, isParent: false, isChild: false, parentId: null, transferId: null, cleared: false, reconciled: false, startingBalance: false, scheduleId: null });
function fixture(t, { dryRun = false, rules = [], backupFailure = false, persistent = false } = {}) {
  const directory = tempDirectory(t), config = validateConfig({ ...inputConfig(), dryRun, backup: { keyRef: 'backup-key' }, categorization: { rules } }, directory);
  const identity = identityFromConfig(config), context = { householdId: identity.householdId, budgetId: identity.budgetId };
  let time = Date.parse('2026-09-15T12:00:00Z');
  const store = new StateStore(persistent ? path.join(directory, 'state.sqlite') : ':memory:', identity, { now: () => time });
  t.after(() => { if (store.db.open) store.close(); });
  const f = { config, identity, context, store, transaction: initialTransaction(), catalog: [category('Food','Alimentação'), category('Other','Outros')], account: { id: 'Account', name: 'Conta principal', offBudget: false, closed: false }, eligible: true, inspections: 0, patches: 0, backups: 0, snapshotCalls: 0, history: [], setTime: value => { time = value; }, get time() { return time; } };
  f.actual = {
    inspectTransaction: async targetId => {
      f.inspections++; if (f.inspectError) throw f.inspectError;
      if (targetId !== f.transaction.id) throw new AppError('MUTATION_TARGET_MISSING');
      const inspection = { context, transaction: structuredClone(f.transaction), account: structuredClone(f.account), payee: { id: 'Payee', name: 'Mercado fictício', transferAccountId: null }, categories: structuredClone(f.catalog), categoryGroups: [{ id: 'daily', name: 'Cotidiano', isIncome: false, hidden: false }], eligibility: { eligible: f.eligible }, fingerprint: transactionFingerprint(context, f.transaction), syncedAt: new Date(time).toISOString() };
      f.onInspect?.(inspection); return inspection;
    },
    snapshot: async () => { f.snapshotCalls++; return { ...context, categories: structuredClone(f.catalog), categoryGroups: [{ id: 'daily', name: 'Cotidiano' }], coverage: { complete: true }, transactions: f.history }; },
    changeCategory: async args => {
      f.patches++; f.lastPatch = args; f.onPatch?.(args);
      const before = structuredClone(f.transaction);
      if (f.resultStatus === 'failed_before') return { status: 'failed_before', code: 'BACKUP_FAILED' };
      if (f.apply !== false) f.transaction.categoryId = args.categoryId;
      if (f.patchError) throw f.patchError;
      const after = structuredClone(f.transaction);
      return { status: f.resultStatus ?? 'applied', code: f.resultStatus === 'uncertain' ? 'MUTATION_UNCERTAIN' : null, before, after, beforeFingerprint: transactionFingerprint(context, before), afterFingerprint: transactionFingerprint(context, after), backupRef: backupReference('actual', args.operationId), verifiedAt: new Date(time).toISOString() };
    }
  };
  f.backup = async (targetStore, options) => {
    f.backups++;
    assert.equal(targetStore.db.prepare('SELECT state FROM operations WHERE id=?').get(options.operationId).state, 'reserved');
    if (backupFailure) throw new Error('SECRET_CANARY');
    return backupReference('state', options.operationId);
  };
  f.actions = new CategorizationActions({ config, store, actual: f.actual, now: () => new Date(time), backupStateImpl: f.backup });
  f.request = text => ({ type: 'message', text, identity });
  f.job = (request = f.request('/status')) => {
    const id = store.enqueueJob({ kind: 'command', payload: request, dedupeKey: randomUUID() });
    const job = store.claimJob(); assert.equal(job.id, id); return job;
  };
  f.run = async text => { const request = typeof text === 'string' ? f.request(text) : text, job = f.job(request); const result = await f.actions.handle(request, job); store.completeJob(job.id); return result; };
  f.propose = async () => { const result = await f.run(`/categorizar ${f.transaction.id} Food`); return { result, proposal: f.actions.journal.proposal(result.replyMarkup.inline_keyboard[0][0].callback_data.slice(3), identity) }; };
  f.confirm = async p => { const result = await f.run(`/confirmar ${p.nonce}`); return { result, operation: f.actions.journal.operation(store.db.prepare('SELECT id FROM operations WHERE proposal_id=?').get(p.id).id) }; };
  return f;
}
const code = expected => error => error instanceof AppError && error.code === expected;

test('categorization config uses explicit IDs, closed rules, no write enabled by default', () => {
  const config = validateConfig(inputConfig()); assert.equal(config.dryRun, true); assert.equal(config.backup.keyRef, null); assert.deepEqual(config.categorization.rules, []);
  for (const extra of [{ backup: { keyRef: '../secret' } }, { categorization: { rules: [{ id: 'r', payeeId: 'p', categoryId: 'c', execute: true }] } }, { categorization: { rules: [{ id: 'r', payeeId: 'p', categoryId: 'c' }, { id: 'r', payeeId: 'p', categoryId: 'd' }] } }]) assert.throws(() => validateConfig({ ...inputConfig(), ...extra }), code('CONFIG_INVALID'));
});

test('proposal is case preserving, specific, opaque and replay idempotent before any mutation', async t => {
  const f = fixture(t), request = f.request('/categorizar TxCaseSensitive Food'), job = f.job(request);
  const first = await f.actions.handle(request, job), replay = await f.actions.handle(request, job);
  assert.deepEqual(replay.replyMarkup, first.replyMarkup);
  assert.equal(replay.text, first.text);
  assert.equal(f.inspections, 1); assert.equal(f.patches, 0); assert.equal(f.backups, 0);
  assert.match(first.text, /32,50/); assert.match(first.text, /Mercado fictício/); assert.match(first.text, /"sem categoria" → "Alimentação"/);
  for (const button of first.replyMarkup.inline_keyboard[0]) { assert.ok(Buffer.byteLength(button.callback_data) <= 64); assert.doesNotMatch(button.callback_data, /Food|TxCaseSensitive/); }
  const p = f.store.db.prepare('SELECT * FROM proposals').get();
  assert.equal(p.source_job_id, job.id); assert.equal(p.expires_at - p.created_at, 900000); assert.equal(p.user_id, 123); assert.equal(p.chat_id, 123);
  assert.equal(p.budget_id, f.config.actual.budgetId); assert.match(p.policy_hash, /^[a-f0-9]{64}$/); assert.notEqual(p.before_fingerprint, p.after_fingerprint);
});

test('dry-run confirms a simulation without backup, mutation or confirmed examples', async t => {
  const f = fixture(t, { dryRun: true }), { proposal } = await f.propose(), { operation, result } = await f.confirm(proposal);
  assert.equal(operation.state, 'simulated'); assert.match(result.text, /SIMULAÇÃO/); assert.equal(f.backups, 0); assert.equal(f.patches, 0); assert.equal(f.actions.journal.examples().length, 0); assert.equal(f.transaction.categoryId, null);
});

test('real write consumes approval, reserves journal and blocks retry atomically before read/backup/RPC', async t => {
  const f = fixture(t), { proposal } = await f.propose();
  f.onInspect = () => {
    const op = f.store.db.prepare('SELECT * FROM operations').get(); assert.equal(op.state, 'reserved');
    assert.equal(f.store.db.prepare('SELECT safe_retry FROM jobs WHERE id=?').get(op.confirmation_job_id).safe_retry, 0);
    assert.equal(f.store.db.prepare('SELECT state FROM proposals WHERE id=?').get(proposal.id).state, 'approved');
    assert.equal(f.store.db.prepare('SELECT state FROM operation_items').get().state, 'reserved');
    assert.match(f.store.db.prepare('SELECT payload FROM outbox WHERE dedupe_key=?').get(`operation-start:${op.id}`).payload, /Aprovação recebida/);
  };
  f.onPatch = args => { assert.equal(f.backups, 1); assert.equal(f.store.db.prepare('SELECT state FROM operations WHERE id=?').get(args.operationId).state, 'executing'); assert.deepEqual(args.expectedCategory, category('Food','Alimentação')); };
  const { operation } = await f.confirm(proposal);
  assert.equal(operation.state, 'applied'); assert.equal(f.patches, 1); assert.equal(f.transaction.categoryId, 'Food'); assert.equal(f.actions.journal.examples().length, 1);
  assert.equal(f.store.db.prepare('SELECT state FROM operation_items').get().state, 'applied');
  const events = f.store.db.prepare('SELECT event FROM audit_events WHERE operation_id=? ORDER BY rowid').all(operation.id).map(x => x.event);
  assert.deepEqual(events, ['approval_consumed','state_backup_ready','operation_applied']);
});

test('double callback consumes one nonce once even while first call waits', async t => {
  const f = fixture(t), { proposal } = await f.propose();
  const request = { type: 'callback', callbackId: 'cb', data: `cf:${proposal.nonce}`, identity: f.identity };
  const a = f.job(request), b = f.job(request);
  const results = await Promise.allSettled([f.actions.handle(request, a), f.actions.handle(request, b)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.code, 'PROPOSAL_USED');
  assert.equal(f.patches, 1); assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM operations').get().n, 1);
});

test('confirmation rejects changed identity, expired nonce and forged callback without RPC', async t => {
  const f = fixture(t), { proposal } = await f.propose();
  for (const [key, value] of [['userId',999],['chatId',999],['budgetId','another'],['householdId','another']]) {
    const request = { type: 'callback', callbackId: 'c', data: `cf:${proposal.nonce}`, identity: { ...f.identity, [key]: value } };
    await assert.rejects(f.actions.handle(request, null), code('UNAUTHORIZED'));
  }
  await assert.rejects(f.actions.handle({ type: 'callback', data: 'cf:any:Food', identity: f.identity }, null), code('INPUT_INVALID'));
  f.setTime(proposal.expires_at);
  await assert.rejects(f.actions.confirm(proposal.nonce, { identity: f.identity, job: f.job() }), code('PROPOSAL_EXPIRED'));
  assert.equal(f.patches, 0); assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM operations').get().n, 0);
});

test('changing dryRun, server or rules invalidates the policy that was approved', async t => {
  const f = fixture(t), { proposal } = await f.propose();
  for (const override of [{ dryRun: true }, { actual: { ...f.config.actual, serverURL: 'http://other:5006' } }, { categorization: { rules: [{ id: 'r', payeeId: 'Payee', categoryId: 'Food' }] } }]) {
    const actions = new CategorizationActions({ config: { ...f.config, ...override }, store: f.store, actual: f.actual, backupStateImpl: f.backup });
    await assert.rejects(actions.confirm(proposal.nonce, { identity: f.identity, job: f.job() }), code('PROPOSAL_POLICY_CHANGED'));
  }
  assert.equal(f.patches, 0);
});

test('cancel invalidates both text and callback approval, preserving a tombstone', async t => {
  const f = fixture(t), { proposal } = await f.propose();
  await f.run({ type: 'callback', callbackId: 'c', data: `cx:${proposal.nonce}`, identity: f.identity });
  await assert.rejects(f.actions.confirm(proposal.nonce, { identity: f.identity, job: f.job() }), code('PROPOSAL_USED'));
  assert.equal(f.actions.journal.proposal(proposal.nonce, f.identity).state, 'cancelled'); assert.equal(f.patches, 0);
});

test('ineligible split parent/child, transfer, closed/off-budget and opening balance never prepare writes', async t => {
  for (const overrides of [{ isParent: true }, { isChild: true }, { parentId: 'parent' }, { transferId: 'transfer' }, { startingBalance: true }, { closed: true }, { offBudget: true }]) {
    const f = fixture(t); Object.assign(f.transaction, overrides); Object.assign(f.account, overrides);
    await assert.rejects(f.propose(), code('MUTATION_INELIGIBLE')); assert.equal(f.patches, 0);
  }
});

test('changed target, missing target, deleted/hidden/renamed/moved destination fail before patch', async t => {
  for (const mutate of [f => { f.transaction.amount--; }, f => { f.inspectError = new AppError('MUTATION_TARGET_MISSING'); }, f => { f.catalog = []; }, f => { f.catalog[0].hidden = true; }, f => { f.catalog[0].name = 'Changed'; }, f => { f.catalog[0].groupId = 'another'; }, f => { f.transaction.isChild = true; }]) {
    const f = fixture(t), { proposal } = await f.propose(); mutate(f);
    const { operation } = await f.confirm(proposal); assert.equal(operation.state, 'failed_before'); assert.equal(f.patches, 0); assert.equal(f.backups, 0); assert.equal(f.actions.journal.examples().length, 0);
  }
});

test('state backup failure or absent key blocks mutation and sanitizes errors', async t => {
  for (const absentKey of [false, true]) {
    const f = fixture(t, { backupFailure: true }), { proposal } = await f.propose();
    if (absentKey) {
      // Prepare again under an intentionally keyless policy, rather than changing
      // configuration after approval (which would fail earlier at policy check).
      const config = validateConfig({ ...inputConfig(), dryRun: false });
      f.actions = new CategorizationActions({ config, store: f.store, actual: f.actual });
      const next = await f.propose(); Object.assign(proposal, next.proposal);
    }
    const { operation, result } = await f.confirm(proposal); assert.equal(operation.state, 'failed_before'); assert.equal(operation.error_code, 'BACKUP_FAILED'); assert.equal(f.patches, 0); assert.doesNotMatch(result.text, /SECRET_CANARY/);
  }
});

test('mutation timeout after patch and failed sync are uncertain, never successful examples', async t => {
  for (const throwing of [false, true]) {
    const f = fixture(t), { proposal } = await f.propose();
    if (throwing) f.patchError = new Error('SECRET_CANARY'); else f.resultStatus = 'uncertain';
    const { operation, result } = await f.confirm(proposal);
    assert.equal(operation.state, 'uncertain'); assert.equal(f.transaction.categoryId, 'Food'); assert.equal(f.actions.journal.examples().length, 0); assert.doesNotMatch(result.text, /SECRET_CANARY/);
    const observed = await f.actions.reconcile(operation.id, f.identity);
    assert.match(observed.text, /igual ao resultado proposto/); assert.match(observed.text, /não comprova quem/); assert.equal(f.actions.journal.operation(operation.id).state, 'observed_after'); assert.equal(f.actions.journal.operation(operation.id).initial_outcome, 'uncertain'); assert.equal(f.patches, 1); assert.equal(f.actions.journal.examples().length, 0);
  }
});

test('readback inconsistent with proposed fingerprint is uncertain even if adapter claims applied', async t => {
  const f = fixture(t), { proposal } = await f.propose();
  f.onPatch = () => { f.transaction.notes = 'changed concurrently'; };
  assert.equal((await f.confirm(proposal)).operation.state, 'uncertain'); assert.equal(f.actions.journal.examples().length, 0);
});

test('undo creates a new confirmation, restores category null and deactivates learning', async t => {
  const f = fixture(t), { proposal } = await f.propose(), { operation } = await f.confirm(proposal);
  const response = await f.run(`/desfazer ${operation.id}`), undo = f.actions.journal.proposal(response.replyMarkup.inline_keyboard[0][0].callback_data.slice(3), f.identity);
  assert.notEqual(undo.id, proposal.id); assert.notEqual(undo.nonce, proposal.nonce); assert.equal(undo.after.categoryId, null); assert.equal(f.patches, 1); assert.equal(undo.undo_of, operation.id);
  assert.match(response.text, /"Alimentação" → "sem categoria"/);
  const result = await f.confirm(undo); assert.equal(result.operation.state, 'applied'); assert.equal(f.patches, 2); assert.equal(f.transaction.categoryId, null); assert.equal(f.actions.journal.examples().length, 0);
  assert.deepEqual(f.lastPatch.expectedCategory, null);
});

test('undo refuses stale fingerprint and an older operation after local category ABA', async t => {
  const f = fixture(t), { proposal } = await f.propose(), { operation } = await f.confirm(proposal);
  f.transaction.notes = 'externally modified';
  await assert.rejects(f.actions.undo(operation.id, { identity: f.identity, job: f.job() }), code('MUTATION_CONFLICT'));
  f.transaction.notes = initialTransaction().notes;
  const second = await f.run('/categorizar TxCaseSensitive Other');
  await f.confirm(f.actions.journal.proposal(second.replyMarkup.inline_keyboard[0][0].callback_data.slice(3), f.identity));
  const third = await f.propose(); await f.confirm(third.proposal);
  await assert.rejects(f.actions.undo(operation.id, { identity: f.identity, job: f.job() }), code('UNDO_UNAVAILABLE'));
  assert.equal(f.actions.journal.examples().length, 1); assert.equal(f.actions.journal.examples()[0].category_id, 'Food');
});

test('restart after reservation preserves uncertain operation/item and never requeues unsafe job', async t => {
  const f = fixture(t, { persistent: true }), { proposal } = await f.propose(), job = f.job();
  const { operationId } = f.actions.journal.reserve(proposal.nonce, { identity: f.identity, job, config: f.config });
  const filename = f.store.db.name; f.store.close();
  const reopened = new StateStore(filename, f.identity, { now: () => f.time }); reopened.recover();
  try {
  assert.equal(reopened.db.prepare('SELECT state FROM operations WHERE id=?').get(operationId).state, 'uncertain');
  assert.equal(reopened.db.prepare('SELECT state FROM operation_items').get().state, 'uncertain');
  assert.equal(reopened.db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id).state, 'uncertain'); assert.equal(reopened.claimJob(), null); assert.equal(f.patches, 0);
  } finally { reopened.close(); }
});

test('crash between applied RPC and journal commit recovers as uncertain without a second patch', async t => {
  const f = fixture(t), { proposal } = await f.propose(), original = f.actions.journal.finish;
  f.actions.journal.finish = () => { throw new AppError('STORAGE_FAILED'); };
  await assert.rejects(f.actions.confirm(proposal.nonce, { identity: f.identity, job: f.job() }), code('STORAGE_FAILED'));
  f.actions.journal.finish = original; f.store.recover();
  const op = f.actions.journal.operations()[0]; assert.equal(op.state, 'uncertain'); assert.equal(f.patches, 1); assert.equal(f.actions.journal.examples().length, 0);
  await f.actions.reconcile(op.id, f.identity); assert.equal(f.patches, 1);
});

test('failJob uses durable unsafe flag rather than stale job object', async t => {
  const f = fixture(t), { proposal } = await f.propose(), job = f.job(); assert.equal(job.safe_retry, 1);
  f.actions.journal.reserve(proposal.nonce, { identity: f.identity, job, config: f.config }); f.store.failJob(job, 'STORAGE_FAILED');
  assert.equal(f.store.db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id).state, 'uncertain');
});

test('retention removes expired/resolved financial payloads but preserves uncertain journal', async t => {
  const f = fixture(t), { proposal } = await f.propose(), { operation } = await f.confirm(proposal);
  const pending = await f.run('/categorizar TxCaseSensitive Other'), nonce = pending.replyMarkup.inline_keyboard[0][0].callback_data.slice(3);
  f.patchError = new Error('timeout'); await f.confirm(f.actions.journal.proposal(nonce, f.identity));
  f.setTime(f.time + 91 * 86400000); f.store.prune(90);
  assert.equal(f.actions.journal.operation(operation.id).before, null); assert.equal(f.actions.journal.examples().length, 0);
  const uncertain = f.actions.journal.operations().find(o => o.state === 'uncertain'); assert.ok(f.actions.journal.operation(uncertain.id).before);
  assert.ok(f.actions.journal.proposal(nonce, f.identity).before);
  assert.equal(f.actions.journal.proposal(proposal.nonce, f.identity).expectedCategory, null);
});

test('rules precede examples/history; conflicting rules have low confidence and maximum three options', async t => {
  const f = fixture(t), inspection = await f.actual.inspectTransaction(f.transaction.id);
  const options = recommendCategories({ inspection, rules: [{ id: 'one', payeeId: 'Payee', categoryId: 'Food' }] }); assert.equal(options[0].confidence, 'alta'); assert.equal(options[0].source, 'rule');
  const conflict = recommendCategories({ inspection, rules: [{ id: 'one', payeeId: 'Payee', categoryId: 'Food' }, { id: 'two', payeeId: 'Payee', categoryId: 'Other' }] });
  assert.equal(conflict.length, 2); assert.ok(conflict.every(x => x.confidence === 'baixa' && x.evidence.conflict));
  assert.equal(recommendCategories({ inspection, rules: [{ id: 'deleted', payeeId: 'Payee', categoryId: 'Missing' }], history: [{ ...initialTransaction(), id: 'another', categoryId: 'Food' }] }).length, 0);
});

test('confirmed confidence counts unique active targets: 5/5 high, 9/10 medium, duplicates not evidence', async t => {
  const f = fixture(t), inspection = await f.actual.inspectTransaction(f.transaction.id), feature_key = featureKey(f.context, f.transaction);
  const examples = Array.from({ length: 5 }, (_, i) => ({ active: 1, feature_key, target_id: `t${i}`, category_id: 'Food' }));
  let result = recommendCategories({ inspection, examples }); assert.equal(result[0].confidence, 'alta'); assert.equal(result[0].evidence.count, 5);
  result = recommendCategories({ inspection, examples: Array(8).fill(examples[0]) }); assert.equal(result[0].evidence.count, 1); assert.notEqual(result[0].confidence, 'alta');
  const minority = Array.from({ length: 10 }, (_, i) => ({ active: 1, feature_key, target_id: `t${i}`, category_id: i < 9 ? 'Food' : 'Other' }));
  result = recommendCategories({ inspection, examples: minority }); assert.equal(result[0].confidence, 'média'); assert.equal(result[0].evidence.agreement, .9);
  assert.equal(recommendCategories({ inspection, examples: examples.map(e => ({ ...e, active: 0 })) }).length, 0);
});

test('categories paginate without hidden destinations; recommendations work with model disabled and no model call', async t => {
  const f = fixture(t, { rules: [{ id: 'payee-rule', payeeId: 'Payee', categoryId: 'Food' }] });
  f.catalog.push(...Array.from({ length: 11 }, (_, i) => category(`Extra${i}`)), { ...category('Hidden'), hidden: true });
  const list = await f.run('/categorias pagina 2'); assert.match(list.text, /página 2\/2/); assert.doesNotMatch(list.text, /Hidden/);
  const suggestion = await f.run('/sugerir TxCaseSensitive'); assert.match(suggestion.text, /regra explícita local/); assert.match(suggestion.text, /confiança alta/); assert.equal(f.patches, 0); assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM proposals').get().n, 0);
  f.catalog = []; const empty = await f.run('/categorias'); assert.match(empty.text, /Nenhuma categoria/);
});

test('commands integration and Telegram failure do not reexecute a completed financial action', async t => {
  const f = fixture(t), handler = createCommandHandler({ config: f.config, store: f.store, actual: f.actual, actionService: f.actions, intentClient: { interpret: () => { throw new Error('must not call model'); } } });
  const { proposal } = await f.propose();
  f.store.enqueueJob({ kind: 'command', payload: f.request(`/confirmar ${proposal.nonce}`), dedupeKey: 'confirm-command' });
  const events = [], logger = (...args) => events.push(args), telegram = { sendMessage: async () => { throw new Error('SECRET_CANARY'); } };
  await processOneJob({ store: f.store, handler, telegram, logger }); assert.equal(f.patches, 1);
  await processOneDelivery({ store: f.store, telegram, logger }); f.setTime(f.time + 2000); await processOneDelivery({ store: f.store, telegram, logger });
  f.store.recover(); assert.equal(await processOneJob({ store: f.store, handler, telegram, logger }), false); assert.equal(f.patches, 1);
  assert.equal(f.actions.journal.operations()[0].state, 'applied'); assert.equal(f.actions.journal.examples().length, 1); assert.doesNotMatch(JSON.stringify(events), /SECRET_CANARY|Food|Payee|32,50/);
});

test('malformed applied result has no success without consistent before, error code and actual backup trail', async t => {
  for (const corrupt of [r => { delete r.before; }, r => { r.before.amount--; }, r => { r.code = 'BACKUP_FAILED'; }, r => { delete r.backupRef; }, r => { r.backupRef.kind = 'state'; }, r => { r.backupRef.operationId = randomUUID(); }, r => { r.backupRef.sha256 = 'invalid'; }, r => { r.backupRef.bytes = -1; }]) {
    const f = fixture(t), { proposal } = await f.propose(), change = f.actual.changeCategory;
    f.actual.changeCategory = async args => { const result = await change(args); corrupt(result); return result; };
    assert.equal((await f.confirm(proposal)).operation.state, 'uncertain'); assert.equal(f.actions.journal.examples().length, 0);
  }
});

test('observed-after uncertainty can be restored to null only through a new explicit proposal', async t => {
  const f = fixture(t), { proposal } = await f.propose(); f.patchError = new Error('timeout');
  const { operation } = await f.confirm(proposal); await f.actions.reconcile(operation.id, f.identity);
  assert.equal(f.store.status().uncertainOperations, 0); assert.equal(f.store.status().observedOperations, 1);
  const response = await f.run(`/desfazer ${operation.id}`), undo = f.actions.journal.proposal(response.replyMarkup.inline_keyboard[0][0].callback_data.slice(3), f.identity);
  assert.match(response.text, /resultado original foi incerto/); assert.match(response.text, /autoria.*não comprovada/); assert.equal(f.patches, 1); assert.equal(undo.after.categoryId, null);
  f.patchError = null; assert.equal((await f.confirm(undo)).operation.state, 'applied'); assert.equal(f.transaction.categoryId, null); assert.equal(f.actions.journal.examples().length, 0);
  assert.equal(f.actions.journal.operation(operation.id).initial_outcome, 'uncertain');
});

test('observed-before does not repeat mutation; applied history stays proven after a divergent current read', async t => {
  const f = fixture(t), { proposal } = await f.propose(); f.apply = false; f.patchError = new Error('timeout');
  const { operation } = await f.confirm(proposal); await f.actions.reconcile(operation.id, f.identity);
  assert.equal(f.actions.journal.operation(operation.id).state, 'observed_before'); assert.equal(f.patches, 1);
  f.apply = true; f.patchError = null;
  const second = await f.propose(), proven = (await f.confirm(second.proposal)).operation;
  f.transaction.categoryId = 'Other'; await f.actions.reconcile(proven.id, f.identity);
  assert.equal(f.actions.journal.operation(proven.id).state, 'applied'); assert.equal(f.actions.journal.operation(proven.id).reconciliation, 'diverged'); assert.equal(f.actions.journal.examples().length, 0);
  await assert.rejects(f.actions.undo(proven.id, { identity: f.identity, job: f.job() }), code('MUTATION_CONFLICT'));
});

test('a new real reservation deactivates prior target evidence even if mutation later becomes uncertain', async t => {
  const f = fixture(t), { proposal } = await f.propose(); await f.confirm(proposal); assert.equal(f.actions.journal.examples().length, 1);
  const next = await f.run('/categorizar TxCaseSensitive Other'), p = f.actions.journal.proposal(next.replyMarkup.inline_keyboard[0][0].callback_data.slice(3), f.identity);
  f.onInspect = () => { assert.equal(f.actions.journal.examples().length, 0); }; f.patchError = new Error('timeout');
  assert.equal((await f.confirm(p)).operation.state, 'uncertain'); assert.equal(f.actions.journal.examples().length, 0);
});

test('operation result and outbox commit together before job completion, with exactly one final delivery', async t => {
  const f = fixture(t), { proposal } = await f.propose(), job = f.job();
  const result = await f.actions.confirm(proposal.nonce, { identity: f.identity, job });
  const op = f.actions.journal.operations()[0]; assert.equal(f.store.db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id).state, 'running');
  const final = f.store.db.prepare('SELECT * FROM outbox WHERE dedupe_key=?').get(`operation-result:${op.id}:0`); assert.match(final.payload, /Categoria alterada/);
  f.store.completeJob(job.id, result); assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox WHERE dedupe_key=?').get(`operation-result:${op.id}:0`).n, 1);
  const request = f.request(`/operacoes ${op.id}`), statusJob = f.job(request), status = await f.actions.handle(request, statusJob);
  f.store.completeJob(statusJob.id, status); assert.ok(f.store.db.prepare('SELECT id FROM outbox WHERE dedupe_key=?').get(`job:${statusJob.id}:0`));
});

test('restart closes a running confirmation when operation and final outbox already committed', async t => {
  const f = fixture(t), { proposal } = await f.propose(), job = f.job();
  await f.actions.confirm(proposal.nonce, { identity: f.identity, job }); f.store.recover();
  assert.equal(f.store.db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id).state, 'done'); assert.equal(f.store.claimJob(), null); assert.equal(f.patches, 1);
});

test('acknowledgment insertion failure rolls back approval consumption, operation and unsafe marker', async t => {
  const f = fixture(t), { proposal } = await f.propose(), job = f.job(), enqueue = f.store.enqueueOutbox;
  f.store.enqueueOutbox = () => { throw new AppError('STORAGE_FAILED'); };
  assert.throws(() => f.actions.journal.reserve(proposal.nonce, { identity: f.identity, job, config: f.config }), code('STORAGE_FAILED'));
  f.store.enqueueOutbox = enqueue;
  assert.equal(f.actions.journal.proposal(proposal.nonce, f.identity).state, 'pending'); assert.equal(f.store.db.prepare('SELECT safe_retry FROM jobs WHERE id=?').get(job.id).safe_retry, 1); assert.equal(f.actions.journal.operations().length, 0);
});

test('final outbox failure rolls back outcome and feedback in the same transaction', async t => {
  const f = fixture(t), { proposal } = await f.propose(), job = f.job();
  const { operationId } = f.actions.journal.reserve(proposal.nonce, { identity: f.identity, job, config: f.config });
  f.actions.journal.executing(operationId, backupReference('state', operationId));
  const enqueue = f.store.enqueueOutbox; f.store.enqueueOutbox = () => { throw new AppError('STORAGE_FAILED'); };
  assert.throws(() => f.actions.journal.finish(operationId, { state: 'applied' }), code('STORAGE_FAILED')); f.store.enqueueOutbox = enqueue;
  assert.equal(f.actions.journal.operation(operationId).state, 'executing'); assert.equal(f.actions.journal.examples().length, 0); assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event='operation_applied'").get().n, 0);
});

test('external labels are quoted and strip bidi; hidden groups stay out of category listing', async t => {
  const f = fixture(t); f.account.name = 'Conta\u202e\n/confirmar falso'; f.catalog[0].name = 'Food\u202e"/cancelar';
  const { result } = await f.propose(); assert.doesNotMatch(result.text, /\u202e/); assert.match(result.text, /Conta: "Conta \/confirmar falso"/);
  const snapshot = f.actual.snapshot; f.actual.snapshot = async period => { const value = await snapshot(period); value.categoryGroups[0].hidden = true; return value; };
  assert.match((await f.run('/categorias')).text, /Nenhuma categoria/);
});

test('expired and cancelled proposals minimize financial data while preserving one-use tombstones', async t => {
  const f = fixture(t), first = await f.propose(); await f.run(`/cancelar ${first.proposal.nonce}`);
  const pending = await f.propose(); f.setTime(f.time + 91 * 86400000); f.store.prune(90);
  for (const p of [first.proposal, pending.proposal]) { const row = f.actions.journal.proposal(p.nonce, f.identity); assert.equal(row.before, null); assert.equal(row.after, null); assert.equal(row.display, null); assert.equal(row.expectedCategory, null); assert.equal(row.target_id, null); assert.ok(row.source_job_id); }
  assert.equal(f.actions.journal.proposal(pending.proposal.nonce, f.identity).state, 'expired');
});

test('same-name categories remain distinguishable in exact confirmation and recommendations', async t => {
  const f = fixture(t, { rules: [{ id: 'r', payeeId: 'Payee', categoryId: 'Food' }] });
  f.transaction.categoryId = 'Other'; f.catalog[0].name = 'Outros'; f.catalog[1].name = 'Outros'; f.catalog[1].groupId = 'OtherGroup';
  const inspect = f.actual.inspectTransaction; f.actual.inspectTransaction = async id => { const value = await inspect(id); value.categoryGroups.push({ id: 'OtherGroup', name: 'Viagem' }); return value; };
  const { result } = await f.propose(); assert.match(result.text, /"Viagem" → "Cotidiano"/); assert.match(result.text, /Other → Food/);
  assert.match((await f.run('/sugerir TxCaseSensitive')).text, /grupo "Cotidiano"/);
});

test('action responses keep measured deterministic metadata without diagnostic footers', async t => {
  const f = fixture(t, { rules: [{ id: 'r', payeeId: 'Payee', categoryId: 'Food' }] });
  const messages = [await f.run('/categorias'), await f.run('/sugerir TxCaseSensitive')];
  const first = await f.propose(); messages.push(first.result, await f.run(`/cancelar ${first.proposal.nonce}`));
  const second = await f.propose(), confirmed = await f.confirm(second.proposal);
  messages.push(second.result, confirmed.result, await f.run('/operacoes'), await f.run(`/operacoes ${confirmed.operation.id}`), await f.run(`/reconciliar ${confirmed.operation.id}`), await f.run(`/desfazer ${confirmed.operation.id}`));
  for (const message of messages) {
    assert.doesNotMatch(message.text, /Provedor:|Tempo:|Uso de IA:|Falha: nenhuma/); assert.equal(message.metadata.provider, 'deterministic');
    assert.ok(Number.isSafeInteger(message.metadata.durationMs) && message.metadata.durationMs >= 0);
    assert.ok(message.metadata.reason); assert.equal(message.metadata.usage, null);
    assert.deepEqual(withActionMetadata(message, { durationMs: 999 }), message);
  }
});

test('durable acknowledgment and terminal response preserve exact message/dedupe and visible failure code', async t => {
  const f = fixture(t, { backupFailure: true }), { proposal } = await f.propose(), job = f.job();
  const response = await f.actions.confirm(proposal.nonce, { identity: f.identity, job });
  const op = f.actions.journal.operations()[0];
  const ack = JSON.parse(f.store.db.prepare('SELECT payload FROM outbox WHERE dedupe_key=?').get(`operation-start:${op.id}`).payload).text;
  assert.doesNotMatch(ack, /Provedor:|Tempo:|Uso de IA:/); assert.ok(ack.length > 0);
  const finalText = JSON.parse(f.store.db.prepare('SELECT payload FROM outbox WHERE dedupe_key=?').get(`operation-result:${op.id}:0`).payload).text;
  assert.equal(finalText, response.text); assert.match(finalText, /Falha: BACKUP_FAILED/); assert.doesNotMatch(finalText, /Falha: nenhuma/);
  f.store.completeJob(job.id, response);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox WHERE dedupe_key=?').get(`operation-result:${op.id}:0`).n, 1);
  assert.doesNotMatch(finalText, /Provedor:/);
});

test('restart and sanitized job errors retain uncertainty and failure codes without timing boilerplate', async t => {
  const f = fixture(t), { proposal } = await f.propose(), job = f.job();
  const { operationId } = f.actions.journal.reserve(proposal.nonce, { identity: f.identity, job, config: f.config });
  f.store.recover();
  const recovery = JSON.parse(f.store.db.prepare('SELECT payload FROM outbox WHERE dedupe_key=?').get(`operation-result:${operationId}:0`).payload).text;
  assert.match(recovery, /Falha: MUTATION_UNCERTAIN/); assert.doesNotMatch(recovery, /Provedor:|Tempo:/);
  const rejectedJob = f.job(); f.store.failJob(rejectedJob, 'SECRET_CANARY');
  const error = JSON.parse(f.store.db.prepare('SELECT payload FROM outbox WHERE dedupe_key=?').get(`job-error:${rejectedJob.id}`).payload).text;
  assert.match(error, /Falha: INTERNAL_ERROR/); assert.doesNotMatch(error, /SECRET_CANARY|Provedor:|Tempo:/);
});
