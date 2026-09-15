import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { StateStore, splitMessage } from '../src/storage/store.mjs';
import { acquireLock } from '../src/storage/lock.mjs';
import { identityFromConfig } from '../src/policy/authorize.mjs';
import { memoryStore, tempDirectory, testConfig } from './helpers.mjs';

test('durable inbox, cursor and job are committed atomically with dedupe', t => {
  const { store, identity } = memoryStore(t);
  const request = { type: 'message', text: '/status', identity };
  const id = store.acceptUpdate(5, request);
  assert.ok(id); assert.equal(store.acceptUpdate(5, request), null); assert.equal(store.cursor(), 6);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 1);
  assert.throws(() => store.acceptUpdate(9, { ...request, text: 'x'.repeat(50000) }), /INPUT_INVALID/);
  assert.equal(store.cursor(), 6, 'failed payload rolls back cursor');
  store.acceptUpdate(6, null);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 1);
  const job = store.claimJob(); assert.equal(job.id, id); assert.equal(store.claimJob(), null);
  store.completeJob(id, { text: 'done' });
  const outbox = store.claimOutbox(); assert.equal(outbox.payload.text, 'done');
  store.finishOutbox(outbox.id, { state: 'sent', messageId: 55 });
  assert.equal(store.claimOutbox(), null);
  assert.equal(store.enqueueOutbox({ text: 'done', dedupeKey: `job:${id}:0` }), null);
});

test('completion and output stay atomic and chunk long messages safely', t => {
  const { store } = memoryStore(t);
  const id = store.enqueueJob({ kind: 'read', payload: {}, dedupeKey: 'first' });
  store.claimJob();
  assert.throws(() => store.completeJob(id, { text: 'ok', chatId: 888 }), /UNAUTHORIZED/);
  assert.equal(store.db.prepare('SELECT state FROM jobs WHERE id=?').get(id).state, 'running');
  const text = 'Nome e saldo\n'.repeat(750);
  store.completeJob(id, { text });
  const rows = store.db.prepare('SELECT payload FROM outbox ORDER BY rowid').all().map(r => JSON.parse(r.payload).text);
  assert.equal(rows.join(''), text); assert.ok(rows.every(x => x.length <= 3900));
  assert.equal(splitMessage('😀'.repeat(2100)).join(''), '😀'.repeat(2100));
});

test('restart retries read jobs, preserves unsafe jobs and marks sends uncertain', t => {
  const directory = tempDirectory(t), config = testConfig(directory), identity = identityFromConfig(config);
  const file = path.join(directory, 'state.sqlite');
  let store = new StateStore(file, identity);
  store.bindTelegramBot(888);
  store.enqueueJob({ kind: 'read', payload: {}, dedupeKey: 'read', safeRetry: true }); store.claimJob();
  store.enqueueJob({ kind: 'write', payload: {}, dedupeKey: 'write', safeRetry: false }); store.claimJob();
  store.enqueueOutbox({ text: 'may be delivered', dedupeKey: 'send' }); store.claimOutbox();
  store.setPreference('daily', { enabled: false }); store.close();
  store = new StateStore(file, identity);
  store.recover();
  assert.equal(store.db.prepare("SELECT state FROM jobs WHERE kind='read'").get().state, 'queued');
  assert.equal(store.db.prepare("SELECT state FROM jobs WHERE kind='write'").get().state, 'uncertain');
  assert.equal(store.status().uncertainDeliveries, 1); assert.equal(store.claimOutbox(), null);
  assert.deepEqual(store.getPreference('daily'), { enabled: false });
  assert.throws(() => store.bindTelegramBot(889), /CONFIG_INVALID/);
  store.close();
  assert.throws(() => new StateStore(file, { ...identity, budgetId: 'other-budget' }), /CONFIG_INVALID/);
  assert.throws(() => new StateStore(file, { ...identity, householdId: 'other-home' }), /CONFIG_INVALID/);
  const reopened = new StateStore(file, identity); reopened.close();
});

test('exclusive process lock refuses contention and releases on connection close', t => {
  const directory = tempDirectory(t);
  const release = acquireLock(directory);
  assert.throws(() => acquireLock(directory), /ALREADY_RUNNING/);
  release();
  const releaseAgain = acquireLock(directory); releaseAgain();
});

test('exclusive lock is released after its owning process is killed', { timeout: 10000 }, async t => {
  const directory = tempDirectory(t);
  const source = 'const { acquireLock } = await import(process.argv[1]); acquireLock(process.argv[2]); process.stdout.write("locked\\n"); setInterval(() => {}, 1000);';
  let child;
  try { child = spawn(process.execPath, ['--input-type=module', '-e', source, pathToFileURL(path.resolve('src/storage/lock.mjs')).href, directory], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { if (error.code === 'EPERM' && process.platform === 'win32' && !process.env.CI) { t.skip('Local Windows sandbox cannot spawn a child; Linux CI must exercise process crash recovery.'); return; } throw error; }
  const exited = once(child, 'exit');
  // Register an immediate catch because spawn failure emits error before exit.
  exited.catch(() => {});
  try {
    try { await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('Lock owner exited before readiness'))); }); }
    catch (error) { if (error.code === 'EPERM' && process.platform === 'win32' && !process.env.CI) { t.skip('Local Windows sandbox cannot spawn a child; Linux CI must exercise process crash recovery.'); return; } throw error; }
    assert.throws(() => acquireLock(directory), /ALREADY_RUNNING/);
    child.kill('SIGKILL');
    await exited;
    const release = acquireLock(directory); release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited.catch(() => {}); }
  }
});

test('Telegram idle rollover accepts lower and reused ids in a new persisted epoch', t => {
  let now = 1000;
  const directory = tempDirectory(t), config = testConfig(directory), identity = identityFromConfig(config);
  const filename = path.join(directory, 'state.sqlite');
  const request = { type: 'message', text: '/status', identity };
  let store = new StateStore(filename, identity, { now: () => now });
  assert.ok(store.acceptUpdate(5000, request));
  assert.ok(store.acceptUpdate(9000, request));
  now += 47 * 3600000;
  assert.equal(store.cursor(), 9001);
  now += 3600000;
  assert.equal(store.cursor(), 0, 'conservative reset is after server update retention');
  store.close();
  store = new StateStore(filename, identity, { now: () => now });
  assert.equal(store.cursor(), 0);
  assert.ok(store.acceptUpdate(5000, request), 'id reused from old epoch is a new update');
  assert.equal(store.acceptUpdate(5000, request), null, 'same new update is still deduped');
  assert.equal(store.cursor(), 5001);
  now += 8 * 86400000;
  assert.equal(store.cursor(), 0);
  assert.ok(store.acceptUpdate(2, request));
  assert.equal(store.cursor(), 3);
  assert.deepEqual(store.db.prepare('SELECT DISTINCT epoch FROM telegram_updates ORDER BY epoch').all().map(x => x.epoch), [0, 1, 2]);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 4);
  store.close();
});

test('state boundaries reject wrong household and sanitize error codes', t => {
  const { store, identity } = memoryStore(t);
  assert.throws(() => store.acceptUpdate(1, { identity: { ...identity, householdId: 'other' }, text: 'x' }), /UNAUTHORIZED/);
  assert.throws(() => store.saveSnapshot({ householdId: 'other', budgetId: identity.budgetId }), /UNAUTHORIZED/);
  store.enqueueJob({ kind: 'read', payload: {}, dedupeKey: 'one' });
  store.failJob(store.claimJob(), 'CANARY_SECRET');
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM jobs').all()).includes('CANARY'), false);
  assert.equal(store.claimOutbox().payload.text.includes('CANARY'), false);
});

test('retention removes completed payloads and consistent backup restores state', async t => {
  let now = 1000;
  const { store } = memoryStore(t, { now: () => now });
  store.enqueueJob({ kind: 'read', payload: { text: 'financial' }, dedupeKey: 'one' });
  const job = store.claimJob(); store.completeJob(job.id, { text: 'financial result' });
  const row = store.claimOutbox(); store.finishOutbox(row.id, { state: 'sent', messageId: 1 });
  now += 86400001; store.prune();
  assert.equal(store.db.prepare('SELECT payload FROM jobs').get().payload, null);
  assert.equal(store.db.prepare('SELECT payload FROM outbox').get().payload, null);
  const filename = path.join(tempDirectory(t), 'backup.sqlite');
  await store.backup(filename);
  const restored = new StateStore(filename, store.identity);
  assert.equal(restored.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 1); restored.close();
});
