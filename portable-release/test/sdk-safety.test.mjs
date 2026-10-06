import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { tempDirectory } from './helpers.mjs';
import { loadPinnedActual, patchPinnedSdk } from '../src/actual/sdk-loader.mjs';

const require = createRequire(import.meta.url);
const sdkEntry = require.resolve('@actual-app/api');
const sdkUrl = pathToFileURL(sdkEntry).href;
const sourceHash = () => createHash('sha256').update(fs.readFileSync(sdkEntry)).digest('hex');

if (isMainThread) {
  const run = async args => {
    const worker = new Worker(new URL(import.meta.url), { workerData: args, stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume();
    const timer = setTimeout(() => { void worker.terminate(); }, 30000);
    try {
      return await new Promise((resolve, reject) => {
        let result;
        worker.once('message', message => { result = message; }); worker.once('error', reject);
        // Let outstanding SDK filesystem operations finish naturally before
        // copying the synthetic cache into the next worker's isolated budget.
        worker.once('exit', code => code === 0 && result ? resolve(result) : reject(new Error(`Synthetic SDK safety worker exited without clean result (${code})`)));
      });
    } finally { clearTimeout(timer); await worker.terminate(); }
  };

  test('SDK byte guard accepts only the pinned artifact and removes only its automatic schedule listener', async () => {
    const source = fs.readFileSync(sdkEntry), text = source.toString('utf8');
    const patched = patchPinnedSdk(source, '26.9.0');
    const start = text.indexOf('app$17.events.on("sync", ({ type }) => {');
    const end = text.indexOf('\n});', start) + '\n});'.length;
    assert.ok(start > 0 && end > start);
    assert.equal(patched, text.slice(0, start) + '// FinAIssistent: automatic schedule sync listener disabled in this worker.' + text.slice(end));
    assert.ok(patched.includes('app$17.method("schedule/force-run-service"'));
    for (const [bytes, version] of [[source, '26.9.1'], [Buffer.concat([source, Buffer.from('\n')]), '26.9.0'], [text.replace('app$17.events.on("sync"', 'app$17.events.on("changed"'), '26.9.0'], [null, '26.9.0']]) {
      assert.throws(() => patchPinnedSdk(bytes, version), { code: 'ACTUAL_FAILED' });
    }
    await assert.rejects(loadPinnedActual(), { code: 'ACTUAL_FAILED' }, 'SDK ownership requires an isolated worker');
  });

  for (const stage of ['preloaded', 'esm-cache', 'changed-load-source', 'wrong-version']) {
    test(`SDK loader rejects ${stage} before initialization or secret resolution`, { timeout: 40000 }, async () => {
      assert.deepEqual(await run({ stage }), { rejected: true, code: 'ACTUAL_FAILED', secretReads: 0, networkAttempts: 0 });
    });
  }

  test('real SDK control autoposts on read; guarded lifecycle, restart and category/null keep due schedules unchanged', { timeout: 120000 }, async t => {
    const root = tempDirectory(t), setupDir = path.join(root, 'setup'), originalHash = sourceHash();
    const setup = await run({ stage: 'setup', dataDir: setupDir });
    assert.equal(setup.ok, true, setup.error);
    assert.equal(setup.autoTransactions, 0);
    assert.equal(setup.afterCloseAutoTransactions, 0);
    assert.equal(setup.lastScheduleRun, '2026-09-15');
    const withSyncIdentity = dataDir => {
      fs.cpSync(setupDir, dataDir, { recursive: true });
      const file = path.join(dataDir, 'actual', setup.localId, 'metadata.json');
      const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Only this disposable budget's cached sync identity changes. Its rules,
      // next dates and lastScheduleRun are never altered by the test harness.
      metadata.groupId = 'synthetic-sync-group'; metadata.cloudFileId = 'synthetic-cloud-file';
      fs.writeFileSync(file, JSON.stringify(metadata));
    };
    const controlDir = path.join(root, 'control'), guardedDir = path.join(root, 'guarded');
    withSyncIdentity(controlDir); withSyncIdentity(guardedDir);
    const args = { ...setup, stage: 'read', nowDay: 16 };
    const control = await run({ ...args, dataDir: controlDir, guarded: false });
    assert.equal(control.ok, true, control.error);
    assert.equal(control.autoTransactions, 1, 'the unmodified SDK reproduces the forbidden side effect');
    assert.equal(control.afterCloseAutoTransactions, 1);
    assert.equal(control.lastScheduleRun, '2026-09-16');
    const protectedRead = await run({ ...args, dataDir: guardedDir, guarded: true });
    const protectedRestart = await run({ ...args, dataDir: guardedDir, guarded: true, nowDay: 17 });
    const protectedMutation = await run({ ...args, dataDir: guardedDir, guarded: true, nowDay: 17, mutate: true });
    for (const result of [protectedRead, protectedRestart, protectedMutation]) {
      assert.equal(result.ok, true, result.error);
      assert.equal(result.autoTransactions, 0);
      assert.equal(result.snapshotAutoTransactions, 0);
      assert.equal(result.afterCloseAutoTransactions, 0, 'shutdown sync must not run schedules either');
      assert.equal(result.lastScheduleRun, setup.lastScheduleRun);
      assert.deepEqual(result.schedules, setup.schedules);
      assert.deepEqual(result.categories, setup.categories);
      assert.deepEqual(result.categoryGroups, setup.categoryGroups);
      assert.equal(result.normalizedScheduleCatalog.rulesVersion, 'schedules-1');
      assert.deepEqual(result.normalizedScheduleCatalog.coverage, { complete: true });
      assert.deepEqual(result.normalizedScheduleCatalog.schedules.map(row => row.id).sort(), setup.schedules.map(row => row.id).sort());
      assert.ok(result.fixtureRequests >= 3, 'real download, explicit sync and shutdown all use the protocol fixture');
      assert.equal(result.networkAttempts, 0);
    }
    assert.deepEqual(protectedRead.normalizedScheduleCatalog.schedules, protectedRestart.normalizedScheduleCatalog.schedules);
    assert.deepEqual(protectedRead.normalizedScheduleCatalog.schedules, protectedMutation.normalizedScheduleCatalog.schedules);
    assert.deepEqual(protectedMutation.mutation, { applied: true, categoryOnly: true, nullRestored: true, backupDecrypted: true });
    assert.equal(control.networkAttempts, 0);
    assert.equal(sourceHash(), originalHash, 'the shared package file stays byte-for-byte unchanged');
  });
} else {
  process.stdout.write = () => true; process.stderr.write = () => true;
  const { default: http } = await import('node:http'), { default: https } = await import('node:https'), { default: net } = await import('node:net');
  let networkAttempts = 0, secretReads = 0, fixtureRequests = 0;
  const deny = () => { networkAttempts++; throw new Error('SYNTHETIC_NETWORK_BLOCKED'); };
  http.request = deny; http.get = deny; https.request = deny; https.get = deny;
  net.connect = deny; net.createConnection = deny; globalThis.fetch = deny; syncBuiltinESMExports();
  if (['preloaded', 'esm-cache', 'changed-load-source', 'wrong-version'].includes(workerData.stage)) {
    if (['preloaded', 'esm-cache'].includes(workerData.stage)) {
      await import(sdkUrl);
      if (workerData.stage === 'esm-cache') delete require.cache[sdkEntry];
    } else if (workerData.stage === 'changed-load-source') {
      // The guard must hash nextLoad's bytes, not an earlier filesystem read.
      registerHooks({ load(url, context, nextLoad) {
        const result = nextLoad(url, context);
        return url === sdkUrl ? { ...result, source: Buffer.from(result.source).toString('utf8') + '\n' } : result;
      } });
    } else {
      const read = fs.readFileSync, packageFile = path.resolve(path.dirname(sdkEntry), '../package.json');
      // Worker-local fake package metadata: the installed package stays intact.
      fs.readFileSync = (file, ...options) => file === packageFile ? '{"version":"26.9.1"}' : read(file, ...options);
      syncBuiltinESMExports();
    }
    try {
      const api = await loadPinnedActual();
      const { ActualExecutor } = await import('../src/actual/executor.mjs');
      const executor = new ActualExecutor({ api, config: { dataDir: '', actual: { passwordRef: 'synthetic' } }, resolveSecret: async () => { secretReads++; throw new Error('UNEXPECTED_SECRET_READ'); } });
      await executor.runExclusive(async () => {});
      parentPort.postMessage({ rejected: false, secretReads, networkAttempts });
    } catch (error) { parentPort.postMessage({ rejected: true, code: error.code, secretReads, networkAttempts }); }
  } else {
    const RealDate = Date;
    const now = new RealDate(2026, 8, workerData.nowDay ?? 15, 12).getTime();
    globalThis.Date = class FixtureDate extends RealDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
    const Database = require('better-sqlite3');
    const dataDir = path.join(workerData.dataDir, 'actual');
    const dbFile = () => path.join(dataDir, workerData.localId, 'db.sqlite');
    const metadataAfterClose = async (localId, expectedDay) => {
      const deadline = performance.now() + 5000;
      while (true) {
        let metadata;
        try { metadata = JSON.parse(fs.readFileSync(path.join(dataDir, localId, 'metadata.json'), 'utf8')); } catch {}
        if (metadata?.lastScheduleRun === expectedDay) return metadata;
        if (performance.now() >= deadline) throw new Error('Synthetic metadata did not reach its expected state');
        await delay(25);
      }
    };
    const varint = number => {
      const bytes = [];
      while (number >= 128) { bytes.push((number & 127) | 128); number >>>= 7; }
      bytes.push(number); return Buffer.from(bytes);
    };
    if (workerData.stage === 'read') {
      globalThis.fetch = async (url, options) => {
        const parsed = new URL(url);
        assert.equal(parsed.hostname, 'synthetic.invalid'); assert.equal(parsed.pathname, '/sync/sync'); assert.equal(options.method, 'POST');
        fixtureRequests++;
        const db = new Database(dbFile(), { readonly: true });
        let clock;
        try { clock = JSON.parse(db.prepare('SELECT clock FROM messages_clock WHERE id=1').get().clock); }
        finally { db.close(); }
        // SyncResponse field2 contains the matching Merkle tree. No remote
        // messages. The real SDK still serializes/sends/handles each sync.
        const merkle = Buffer.from(JSON.stringify(clock.merkle));
        return new Response(Buffer.concat([Buffer.from([0x12]), varint(merkle.length), merkle]), { status: 200, headers: { 'Content-Type': 'application/actual-sync' } });
      };
    }
    const api = workerData.guarded ? await loadPinnedActual() : await import(sdkUrl);
    const sorted = rows => rows.toSorted((a, b) => a.id.localeCompare(b.id));
    let executor;
    try {
      if (workerData.stage === 'setup') {
        fs.mkdirSync(dataDir, { recursive: true });
        await api.init({ dataDir, verbose: false });
        await api.runImport('Synthetic schedule safety', async () => {});
        const account = await api.createAccount({ name: 'Synthetic safety account' });
        const payee = await api.createPayee({ name: 'Synthetic safety payee' });
        const group = await api.createCategoryGroup({ name: 'Synthetic safety group' });
        const category = await api.createCategory({ name: 'Synthetic safety category', group_id: group });
        await api.createCategory({ name: 'Synthetic hidden category', group_id: group, hidden: true });
        const schedule = await api.createSchedule({ name: 'Synthetic due autopost', account, payee, amount: -12345, amountOp: 'is', date: '2026-09-16', posts_transaction: true });
        await api.createSchedule({ name: 'Synthetic recurring catalog', account, payee, amount: -2000, amountOp: 'isapprox', date: { frequency: 'monthly', interval: 1, start: '2026-09-16', endMode: 'never', patterns: [{ type: 'day', value: 16 }] }, posts_transaction: false });
        const imported = await api.importTransactions(account, [{ date: '2026-09-15', amount: -250, payee, notes: 'Synthetic category target', imported_id: 'synthetic-safety-target' }]);
        assert.equal(imported.errors.length, 0);
        const simple = (await api.getTransactions(account, '2026-09-15', '2026-09-15')).find(row => row.notes === 'Synthetic category target').id;
        const schedules = sorted(await api.getSchedules()), categories = sorted(await api.getCategories()), categoryGroups = sorted(await api.getCategoryGroups());
        const autoTransactions = (await api.getTransactions(account, '2026-09-15', '2026-09-17')).filter(row => row.schedule === schedule).length;
        const localId = (await api.getBudgets())[0].id;
        await api.shutdown();
        const metadata = await metadataAfterClose(localId, '2026-09-15');
        const db = new Database(path.join(dataDir, localId, 'db.sqlite'), { readonly: true });
        let afterCloseAutoTransactions;
        try { afterCloseAutoTransactions = db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE schedule=? AND tombstone=0').get(schedule).count; }
        finally { db.close(); }
        parentPort.postMessage({ ok: true, localId, account, category, simple, schedule, schedules, categories, categoryGroups, autoTransactions, afterCloseAutoTransactions, lastScheduleRun: metadata.lastScheduleRun, networkAttempts });
      } else {
        const { ActualExecutor } = await import('../src/actual/executor.mjs');
        const { readEncryptedBackup } = await import('../src/backups/encrypted.mjs');
        const config = { dataDir: workerData.dataDir, householdId: 'synthetic', currency: 'BRL', timezone: 'America/Sao_Paulo', dryRun: !workerData.mutate, backup: { keyRef: 'synthetic-key' }, actual: { serverURL: 'http://synthetic.invalid', budgetId: 'synthetic-sync-group', passwordRef: 'synthetic-empty' } };
        const resolveSecret = async ref => { secretReads++; return ref === 'synthetic-key' ? '19'.repeat(32) : ''; };
        executor = new ActualExecutor({ api, config, resolveSecret });
        const snapshot = await executor.snapshot({ start: '2026-09-15', end: '2026-09-17' });
        const normalizedScheduleCatalog = await executor.readSchedules();
        assert.deepEqual(snapshot.categories.map(row => row.id).sort(), workerData.categories.map(row => row.id).sort());
        assert.deepEqual(snapshot.categoryGroups.map(row => row.id).sort(), workerData.categoryGroups.map(row => row.id).sort());
        // The original SDK schedules work asynchronously after sync. Await the
        // observed effect with a monotonic deadline rather than assume timing.
        if (!workerData.guarded) {
          const deadline = performance.now() + 5000;
          while (!(await api.getTransactions(workerData.account, '2026-09-15', '2026-09-17')).some(row => row.schedule === workerData.schedule)) {
            if (performance.now() >= deadline) throw new Error('Original SDK autopost was not observed');
            await delay(25);
          }
        }
        const full = async id => (await api.aqlQuery(api.q('transactions').filter({ id }).select('*').options({ splits: 'all' }))).data[0];
        let mutation = null;
        if (workerData.mutate) {
          const before = await full(workerData.simple), inspection = await executor.inspectTransaction(workerData.simple);
          const input = { operationId: 'synthetic-safety-category', targetId: workerData.simple, context: inspection.context, expectedFingerprint: inspection.fingerprint, categoryId: workerData.category, expectedCategory: inspection.categories.find(row => row.id === workerData.category) };
          const changed = await executor.changeCategory(input);
          assert.equal(changed.status, 'applied');
          assert.deepEqual(await full(workerData.simple), { ...before, category: workerData.category });
          const zip = await readEncryptedBackup(changed.backupRef, { config, resolveSecret });
          assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304'); zip.fill(0);
          const undo = await executor.changeCategory({ ...input, operationId: 'synthetic-safety-undo', categoryId: null, expectedCategory: null, expectedFingerprint: changed.afterFingerprint });
          assert.equal(undo.status, 'applied'); assert.deepEqual(await full(workerData.simple), before);
          mutation = { applied: true, categoryOnly: true, nullRestored: true, backupDecrypted: true };
        }
        const transactions = await api.getTransactions(workerData.account, '2026-09-15', '2026-09-17');
        const result = { ok: true, autoTransactions: transactions.filter(row => row.schedule === workerData.schedule).length, snapshotAutoTransactions: snapshot.transactions.filter(row => row.id !== workerData.simple).length, schedules: sorted(await api.getSchedules()), categories: sorted(await api.getCategories()), categoryGroups: sorted(await api.getCategoryGroups()), normalizedScheduleCatalog, mutation };
        await executor.close();
        const metadata = await metadataAfterClose(workerData.localId, workerData.guarded ? workerData.lastScheduleRun : '2026-09-16');
        const db = new Database(dbFile(), { readonly: true });
        try { result.afterCloseAutoTransactions = db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE schedule=? AND tombstone=0').get(workerData.schedule).count; }
        finally { db.close(); }
        result.lastScheduleRun = metadata.lastScheduleRun;
        parentPort.postMessage({ ...result, fixtureRequests, networkAttempts });
      }
    } catch (error) {
      try { await executor?.close(); await api.shutdown(); } catch {}
      parentPort.postMessage({ ok: false, error: error.code ?? error.message, networkAttempts, fixtureRequests });
    }
  }
}
