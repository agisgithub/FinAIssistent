import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { validateConfig } from '../src/config.mjs';
import { inputConfig } from './helpers.mjs';
import { identityFromConfig } from '../src/policy/authorize.mjs';
import { StateStore } from '../src/storage/store.mjs';
import { CategorizationActions } from '../src/application/actions.mjs';
import { CompanionService } from '../src/companion/service.mjs';
import { TransactionMonitorScheduler } from '../src/jobs/transaction-monitor.mjs';
import { memoryHint, monitorInspection, TRANSACTION_SCAN_INTERVAL_MS } from '../src/categorization/monitor.mjs';
import { automaticCandidate, recommendCategories } from '../src/categorization/recommend.mjs';
import { transactionFingerprint } from '../src/actual/transaction.mjs';

const SHA = 'a'.repeat(64);
const BACKUP_ID = '11111111-1111-4111-8111-111111111111';
const transaction = (id, payeeId = 'merchant', extra = {}) => ({
  id, accountId: 'checking', date: '2026-09-20', amount: -1000, payeeId, notes: '', categoryId: null,
  parentId: null, isParent: false, isChild: false, transferId: null, cleared: false, reconciled: false,
  startingBalance: false, scheduleId: null, ...extra
});

function fixture(t, { automatic = false, rules = [], persistent = false } = {}) {
  const testRoot = path.resolve('work/tests');
  mkdirSync(testRoot, { recursive: true });
  const directory = persistent ? mkdtempSync(path.join(testRoot, 'monitor-')) : process.cwd();
  const config = validateConfig({
    ...inputConfig(), dryRun: false, backup: { keyRef: 'backup-key' }, categorization: { rules },
    companion: { transactionMonitorEnabled: true, autoCategorizeHighConfidence: automatic }
  }, directory);
  const identity = identityFromConfig(config), context = { householdId: identity.householdId, budgetId: identity.budgetId };
  const filename = persistent ? path.join(directory, 'monitor.sqlite') : ':memory:';
  let clock = Date.parse('2026-09-20T12:01:00Z'), serial = 0, store;
  const f = {
    config, identity, rows: [], patches: 0, backups: 0,
    accounts: [
      { id: 'checking', name: 'Conta', offBudget: false, closed: false, balance: 0 },
      { id: 'closed', name: 'Encerrada', offBudget: false, closed: true, balance: 0 },
      { id: 'off', name: 'Fora do orçamento', offBudget: true, closed: false, balance: 0 }
    ],
    categories: [{ id: 'food', name: 'Alimentação', groupId: 'expenses', isIncome: false, hidden: false }],
    categoryGroups: [{ id: 'expenses', name: 'Despesas', isIncome: false, hidden: false }],
    payees: [
      { id: 'merchant', name: 'Loja Nova', transferAccountId: null },
      { id: 'old', name: 'Loja Antiga', transferAccountId: null },
      { id: 'transfer', name: 'Transferência', transferAccountId: 'checking' }
    ]
  };
  const snapshot = period => ({
    id: `snapshot-${++serial}`, ...context, timezone: config.timezone, currency: config.currency, period: { ...period },
    syncedAt: new Date(clock).toISOString(), createdAt: new Date(clock).toISOString(), rulesVersion: '1',
    transactionMetadataVersion: '1', coverage: { complete: true, failedAccountIds: [] },
    accounts: structuredClone(f.accounts), categories: structuredClone(f.categories),
    categoryGroups: structuredClone(f.categoryGroups), payees: structuredClone(f.payees),
    transactions: structuredClone(f.rows.filter(row => row.date >= period.start && row.date <= period.end)), budgetMonths: []
  });
  const inspect = targetId => {
    const full = snapshot({ start: '2025-09-21', end: '2026-09-20' });
    const row = full.transactions.find(item => item.id === targetId);
    assert.ok(row, `missing fixture transaction ${targetId}`);
    const account = full.accounts.find(item => item.id === row.accountId) ?? null;
    const payee = full.payees.find(item => item.id === row.payeeId) ?? null;
    const reason = row.isParent || row.isChild || row.parentId ? 'split'
      : row.transferId || payee?.transferAccountId ? 'transfer'
        : row.startingBalance ? 'starting_balance' : account?.offBudget ? 'off_budget'
          : account?.closed ? 'closed_account' : !account ? 'missing_account'
            : row.payeeId && !payee ? 'missing_payee' : null;
    return { context, transaction: row, account, payee, categories: full.categories, categoryGroups: full.categoryGroups, fingerprint: transactionFingerprint(context,row), eligibility: { eligible: reason === null, reason } };
  };
  f.actual = {
    snapshot: async period => snapshot(period),
    inspectTransaction: async targetId => inspect(targetId),
    changeCategory: async input => {
      f.patches++;
      const row = f.rows.find(item => item.id === input.targetId), before = structuredClone(row);
      assert.equal(transactionFingerprint(context, before), input.expectedFingerprint);
      row.categoryId = input.categoryId;
      const after = structuredClone(row);
      return {
        status: 'applied', code: null, before, after,
        beforeFingerprint: transactionFingerprint(context, before), afterFingerprint: transactionFingerprint(context, after),
        verifiedAt: new Date(clock).toISOString(),
        backupRef: { id: BACKUP_ID, kind: 'actual', operationId: input.operationId, sha256: SHA, bytes: 512, createdAt: new Date(clock).toISOString() }
      };
    }
  };
  const wire = () => {
    f.store = store;
    f.actions = new CategorizationActions({
      config, store, actual: f.actual, now: () => new Date(clock),
      backupStateImpl: async (_store, { operationId }) => {
        f.backups++;
        return { id: BACKUP_ID, kind: 'state', operationId, sha256: SHA, bytes: 512, createdAt: new Date(clock).toISOString() };
      }
    });
    f.companion = new CompanionService({ config, store, now: () => new Date(clock) });
    f.scheduler = new TransactionMonitorScheduler({ config, store, actual: f.actual, actions: f.actions, companionService: f.companion, now: () => clock });
  };
  store = new StateStore(filename, identity, { now: () => clock });
  wire();
  t.after(() => {
    if (store?.db.open) store.close();
    if (persistent) {
      const relative = path.relative(testRoot,path.resolve(directory));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe cleanup target');
      rmSync(directory,{recursive:true,force:true});
    }
  });
  f.runNext = async expectedKind => {
    const job = store.claimJob();
    assert.ok(job);
    assert.equal(job.kind, expectedKind);
    await f.scheduler.runJob(job);
    return job;
  };
  f.scan = async () => {
    const ids = f.scheduler.tick();
    assert.equal(ids.length, 1);
    const job = await f.runNext('transaction_scan');
    assert.equal(job.id, ids[0]);
  };
  f.advance = () => { clock += TRANSACTION_SCAN_INTERVAL_MS; };
  f.reopen = () => { store.close(); store = new StateStore(filename, identity, { now: () => clock }); store.recover(); wire(); };
  return f;
}

test('first complete scan creates a silent baseline that survives restart', async t => {
  const f = fixture(t, { persistent: true });
  f.rows.push(transaction('existing', 'old'));
  await f.scan();
  const initializedAt = f.store.db.prepare('SELECT initialized_at FROM transaction_monitor_state').get().initialized_at;
  assert.equal(f.store.db.prepare("SELECT state FROM transaction_observations WHERE transaction_id='existing'").get().state, 'baseline');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, 0);

  f.reopen();
  f.advance();
  await f.scan();
  assert.equal(f.store.db.prepare('SELECT initialized_at FROM transaction_monitor_state').get().initialized_at, initializedAt);
  assert.deepEqual(f.store.db.prepare('SELECT baseline FROM transaction_monitor_runs ORDER BY slot').all().map(row => row.baseline), [1, 0]);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind IN ('transaction_question','automatic_category')").get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, 0);
});

test('one new uncertain expense asks once while ineligible transactions stay ignored', async t => {
  const f = fixture(t, { automatic: true });
  await f.scan();
  f.rows.push(
    transaction('eligible'),
    transaction('income', 'merchant', { amount: 1000 }),
    transaction('categorized', 'old', { categoryId: 'food' }),
    transaction('split', 'merchant', { isChild: true, parentId: 'parent' }),
    transaction('transfer', 'transfer'),
    transaction('opening', 'merchant', { startingBalance: true }),
    transaction('closed', 'merchant', { accountId: 'closed' }),
    transaction('off-budget', 'merchant', { accountId: 'off' })
  );
  f.advance();
  await f.scan();
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM transaction_observations WHERE state='question_queued'").get().n, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM transaction_observations WHERE state='ignored'").get().n, 7);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='automatic_category'").get().n, 0);

  await f.runNext('transaction_question');
  assert.equal(f.store.db.prepare("SELECT state FROM transaction_observations WHERE transaction_id='eligible'").get().state, 'questioned');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, 1);
  f.advance();
  await f.scan();
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='transaction_question'").get().n, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, 1);
  f.rows.find(row => row.id === 'eligible').categoryId = 'food';
  f.advance();
  await f.scan();
  assert.equal(f.store.db.prepare("SELECT state FROM transaction_observations WHERE transaction_id='eligible'").get().state, 'resolved_external');
  assert.equal(f.store.db.prepare('SELECT state FROM outbox').get().state, 'failed');
});

test('a complete scan revokes questions whose transaction was removed or left the monitored period',async t=>{
  for(const mode of ['removed','out-of-period']) await t.test(mode,async t=>{
    const f=fixture(t,{rules:[{id:'rule',payeeId:'merchant',accountId:'checking',categoryId:'food'}]});
    await f.scan();f.rows.push(transaction(`vanish-${mode}`));f.advance();await f.scan();await f.runNext('transaction_question');
    const outbox=f.store.db.prepare('SELECT * FROM outbox').get();
    assert.equal(f.store.db.prepare('SELECT state FROM proposals').get().state,'pending');
    assert.equal(f.scheduler.authorizeDelivery({id:outbox.id}),true);
    if(mode==='removed')f.rows.length=0;else f.rows[0].date='2025-01-01';
    f.advance();await f.scan();
    const observation=f.store.db.prepare('SELECT state,decision_json,job_id,operation_id FROM transaction_observations').get();
    assert.deepEqual(observation,{state:'ignored',decision_json:null,job_id:null,operation_id:null});
    assert.equal(f.store.db.prepare('SELECT state FROM proposals').get().state,'expired');
    assert.equal(f.store.db.prepare('SELECT state FROM outbox').get().state,'failed');
    assert.equal(f.store.db.prepare('SELECT cancelled FROM transaction_monitor_deliveries').get().cancelled,1);
    assert.equal(f.scheduler.authorizeDelivery({id:outbox.id}),false);
  });
});

test('a high-confidence rule applies once without creating a confirmed example', async t => {
  const f = fixture(t, { automatic: true, rules: [{ id: 'groceries', payeeId: 'merchant', accountId: 'checking', categoryId: 'food' }] });
  await f.scan();
  f.rows.push(transaction('automatic'));
  f.advance();
  await f.scan();
  assert.equal(f.store.db.prepare("SELECT state FROM transaction_observations WHERE transaction_id='automatic'").get().state, 'auto_queued');

  const job = await f.runNext('automatic_category');
  const operation = f.store.db.prepare('SELECT origin,state FROM operations').get();
  assert.deepEqual(operation, { origin: 'companion_high_confidence', state: 'applied' });
  assert.equal(f.rows[0].categoryId, 'food');
  assert.equal(f.patches, 1);
  assert.equal(f.backups, 1);
  assert.equal(f.store.db.prepare('SELECT safe_retry FROM jobs WHERE id=?').get(job.id).safe_retry, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM category_examples').get().n, 0);
  assert.equal(f.store.db.prepare("SELECT state FROM transaction_observations WHERE transaction_id='automatic'").get().state, 'applied');
});

test('classification memory can enrich a question but never changes score or automatic eligibility', t => {
  const f = fixture(t, { automatic: true }), row = transaction('memory');
  f.rows.push(row);
  const inspection = monitorInspection({ accounts:f.accounts,categories:f.categories,categoryGroups:f.categoryGroups,payees:f.payees },row,f.config);
  const before = recommendCategories({ inspection, history: [] });
  assert.equal(memoryHint([{ id:'m_abcdefghijkl',kind:'classification_hint',subject:'Literal',merchantPattern:'Loja .*',categoryName:'Alimentação' }],inspection),null);
  const hint = memoryHint([{ id:'m_abcdefghijkl',kind:'classification_hint',subject:'Lembrança',merchantPattern:'Loja Nova',categoryName:'Alimentação' }],inspection);
  assert.equal(hint.categoryId,'food');
  assert.deepEqual(recommendCategories({ inspection, history: [] }),before);
  assert.equal(automaticCandidate(before),null);
});

test('automatic job revalidates fingerprint, policy and destination before backup or patch',async t=>{
  for(const kind of ['fingerprint','policy','destination']) await t.test(kind,async t=>{
    const f=fixture(t,{automatic:true,rules:[{id:'rule',payeeId:'merchant',accountId:'checking',categoryId:'food'}]});
    await f.scan();f.rows.push(transaction(`guard-${kind}`));f.advance();await f.scan();
    const queued=f.store.db.prepare("SELECT * FROM jobs WHERE kind='automatic_category' AND state='queued'").get();assert.ok(queued);
    if(kind==='fingerprint')f.rows[0].notes='changed';
    if(kind==='policy'){const payload=JSON.parse(queued.payload);payload.policyHash='0'.repeat(64);f.store.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify(payload),queued.id);}
    if(kind==='destination')f.categories.length=0;
    await f.runNext('automatic_category');
    assert.equal(f.patches,0);assert.equal(f.backups,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM operations').get().n,0);
  });
});

test('an uncertain automatic mutation is terminal and never retried',async t=>{
  const f=fixture(t,{automatic:true,rules:[{id:'rule',payeeId:'merchant',accountId:'checking',categoryId:'food'}]});let attempts=0;
  f.actual.changeCategory=async()=>{attempts++;return {status:'uncertain',code:'MUTATION_UNCERTAIN'};};
  await f.scan();f.rows.push(transaction('uncertain'));f.advance();await f.scan();await f.runNext('automatic_category');
  assert.equal(attempts,1);assert.equal(f.store.db.prepare('SELECT state FROM operations').get().state,'uncertain');assert.equal(f.store.db.prepare("SELECT state FROM transaction_observations WHERE transaction_id='uncertain'").get().state,'uncertain');
  f.advance();await f.scan();assert.equal(attempts,1);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='automatic_category'").get().n,1);
});

test('failed-before automatic mutation is eligible for a later scan while its audit remains',async t=>{
  const f=fixture(t,{automatic:true,rules:[{id:'rule',payeeId:'merchant',accountId:'checking',categoryId:'food'}]}),backup=f.actions.backupStateImpl;
  f.actions.backupStateImpl=async()=>{throw new Error('fixture backup failure');};
  await f.scan();f.rows.push(transaction('retryable'));f.advance();await f.scan();await f.runNext('automatic_category');
  assert.equal(f.patches,0);assert.equal(f.store.db.prepare('SELECT state FROM operations').get().state,'failed_before');assert.equal(f.store.db.prepare("SELECT state FROM transaction_observations WHERE transaction_id='retryable'").get().state,'failed_before');
  f.actions.backupStateImpl=backup;f.advance();await f.scan();
  const retry=f.store.db.prepare("SELECT state,job_id,operation_id FROM transaction_observations WHERE transaction_id='retryable'").get();
  assert.equal(retry.state,'auto_queued');assert.ok(retry.job_id);assert.equal(retry.operation_id,null);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='automatic_category'").get().n,2);
  await f.runNext('automatic_category');
  assert.equal(f.patches,1);assert.deepEqual(f.store.db.prepare('SELECT state FROM operations ORDER BY created_at,rowid').all().map(row=>row.state),['failed_before','applied']);
});

test('one scan caps automatic jobs at 20 and questions at 3, preserving overflow',async t=>{
  await t.test('automatic',async t=>{const f=fixture(t,{automatic:true,rules:[{id:'rule',payeeId:'merchant',accountId:'checking',categoryId:'food'}]});await f.scan();for(let i=0;i<21;i++)f.rows.push(transaction(`auto-${i}`));f.advance();await f.scan();assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='automatic_category'").get().n,20);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM transaction_observations WHERE state='pending'").get().n,1);});
  await t.test('questions',async t=>{const f=fixture(t);await f.scan();for(let i=0;i<4;i++)f.rows.push(transaction(`question-${i}`));f.advance();await f.scan();assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='transaction_question'").get().n,3);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM transaction_observations WHERE state='pending'").get().n,1);});
});
