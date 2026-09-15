import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { AppError, errorCode } from '../errors.mjs';
import { normalizeSnapshot, validatePeriod, validMonth } from './snapshot.mjs';
import { inspectCurrent, readTransaction, transactionFingerprint, validateChange, validId } from './transaction.mjs';
import { writeEncryptedBackup } from '../backups/encrypted.mjs';
import { performance } from 'node:perf_hooks';
import { normalizeSchedules } from './schedules.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { readCategoryCatalog, validateCreateCategory, checkCreationAvailable, checkCreationGroup, categoryFingerprint, sameCategoryName } from './category.mjs';

// Owns the SDK's global lifecycle. Production creates exactly one in its worker.
// Tests inject an SDK-shaped fake; no model-facing arbitrary method dispatch exists.
export class ActualExecutor {
  constructor({ api, config, resolveSecret, readbackTimeoutMs = 5000, pollIntervalMs = 25 }) {
    this.api = api;
    this.config = config;
    this.resolveSecret = resolveSecret;
    this.tail = Promise.resolve();
    this.opened = false;
    this.initialized = false;
    this.closed = false;
    this.broken = false;
    this.closing = null;
    this.readbackTimeoutMs = readbackTimeoutMs;
    this.pollIntervalMs = pollIntervalMs;
  }
  runExclusive(fn) {
    if (this.closed) return Promise.reject(new AppError('SHUTTING_DOWN'));
    const task = this.tail.then(async () => {
      if (this.broken) throw new AppError('ACTUAL_FAILED');
      try { await this.open(); return await fn(this.api); }
      catch (error) { throw new AppError(errorCode(error, 'ACTUAL_FAILED')); }
    });
    this.tail = task.catch(() => {});
    return task;
  }
  async open() {
    if (this.opened) return;
    try {
      const dataDir = path.join(this.config.dataDir, 'actual');
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      if (!this.initialized) {
        const password = await this.resolveSecret(this.config.actual.passwordRef);
        // Even a failed init may have allocated SDK resources.
        this.initialized = true;
        await this.api.init({ dataDir, serverURL: this.config.actual.serverURL, password, verbose: false });
      }
      const reference = this.config.actual.encryptionPasswordRef;
      await this.api.downloadBudget(this.config.actual.budgetId, reference ? { password: await this.resolveSecret(reference) } : undefined);
      this.opened = true;
    } catch (error) {
      if (this.initialized) { try { await this.api.shutdown(); } catch { this.broken = true; } }
      this.initialized = false;
      throw new AppError(errorCode(error, 'ACTUAL_FAILED'));
    }
  }
  snapshot(period) {
    validatePeriod(period);
    period = { start: period.start, end: period.end };
    return this.runExclusive(async api => {
      try { await api.sync(); } catch { throw new AppError('ACTUAL_SYNC_FAILED'); }
      const syncedAt = new Date().toISOString();
      let accounts, categories, categoryGroups, payees, budgetMonths;
      try {
        accounts = await api.getAccounts();
        // SDK hidden:true means ONLY hidden; omitted means the full catalog.
        categories = await api.getCategories();
        categoryGroups = await api.getCategoryGroups();
        payees = await api.getPayees();
        const months = await api.getBudgetMonths();
        if (![accounts, categories, categoryGroups, payees, months].every(Array.isArray) || !months.every(validMonth) || new Set(months).size !== months.length) throw new AppError('SNAPSHOT_INVALID');
        budgetMonths = [];
        for (const month of months.filter(m => m >= period.start.slice(0, 7) && m <= period.end.slice(0, 7))) {
          const budget = await api.getBudgetMonth(month);
          if (budget?.month !== month) throw new AppError('SNAPSHOT_INVALID');
          budgetMonths.push(budget);
        }
      } catch (error) { throw new AppError(errorCode(error, 'ACTUAL_FAILED')); }
      const transactions = [], failedAccountIds = [];
      const withBalances = [];
      // Actual 26.9.0 uses host-local dayFromDate(cutoff), not an instant query.
      // Local noon preserves the requested ledger date in every host timezone;
      // config.timezone was already applied when choosing the date-only period.
      const cutoff = new Date(period.end + 'T12:00:00');
      for (const account of accounts) {
        try {
          const balance = await api.getAccountBalance(account.id, cutoff);
          if (!Number.isSafeInteger(balance)) throw new AppError('SNAPSHOT_INVALID');
          const rows = await api.getTransactions(account.id, period.start, period.end);
          if (!Array.isArray(rows)) throw new AppError('SNAPSHOT_INVALID');
          transactions.push(...rows);
          withBalances.push({ ...account, balance });
        } catch {
          failedAccountIds.push(account.id);
          withBalances.push({ ...account, balance: null });
        }
      }
      return normalizeSnapshot({ config: this.config, period, accounts: withBalances, categories, categoryGroups, payees, transactions, budgetMonths, syncedAt, failedAccountIds });
    });
  }
  readSchedules() {
    return this.runExclusive(async api => {
      try { await api.sync(); } catch { throw new AppError('ACTUAL_SYNC_FAILED'); }
      const syncedAt = new Date().toISOString();
      let schedules;
      try { schedules = await api.getSchedules(); }
      catch { throw new AppError('ACTUAL_FAILED'); }
      return normalizeSchedules({ config: this.config, schedules, syncedAt });
    });
  }
  inspectTransaction(targetId) {
    if (!validId(targetId)) return Promise.reject(new AppError('INPUT_INVALID'));
    return this.runExclusive(async api => {
      try { await api.sync(); } catch { throw new AppError('ACTUAL_SYNC_FAILED'); }
      const result = await inspectCurrent(api, this.config, targetId);
      return { ...result, syncedAt: new Date().toISOString() };
    });
  }
  inspectCategoryCatalog() {
    return this.runExclusive(async api => {
      try { await api.sync(); } catch { throw new AppError('ACTUAL_SYNC_FAILED'); }
      return { ...await readCategoryCatalog(api, this.config), syncedAt:new Date().toISOString() };
    });
  }
  async createCategory(input) {
    let args;
    try { args = validateCreateCategory(input); } catch { return {status:'failed_before',code:'INPUT_INVALID'}; }
    if (this.config.dryRun !== false) return {status:'failed_before',code:'MUTATION_DRY_RUN'};
    if (args.context.householdId !== this.config.householdId || args.context.budgetId !== this.config.actual.budgetId) return {status:'failed_before',code:'MUTATION_CONFLICT'};
    let attempted = false, backupRef, category;
    try {
      return await this.runExclusive(async api => {
        const sync = async () => { try { await api.sync(); } catch { throw new AppError('ACTUAL_SYNC_FAILED'); } };
        await sync(); let catalog = await readCategoryCatalog(api,this.config); checkCreationAvailable(catalog,args);
        let bytes;
        try {
          bytes = await api.exportBudget();
          if (!(bytes instanceof Uint8Array) || bytes.length < 4 || Buffer.from(bytes.subarray(0,4)).toString('hex') !== '504b0304') throw new AppError('BACKUP_FAILED');
          backupRef = await writeEncryptedBackup(bytes,{config:this.config,operationId:args.operationId,kind:'actual',resolveSecret:this.resolveSecret});
        } catch { throw new AppError('BACKUP_FAILED'); } finally { bytes?.fill?.(0); }
        await sync(); catalog = await readCategoryCatalog(api,this.config); checkCreationAvailable(catalog,args);
        const existingIds = new Set(catalog.categories.map(row => row.id));
        attempted = true;
        // SDK 26.9.0 api/category-create accepts external group_id/is_income,
        // generates its own ID, and offers no idempotency key. Never retry it.
        const createdId = await api.createCategory({name:args.name,group_id:args.groupId,is_income:args.expectedGroup.isIncome,hidden:false});
        if (!validId(createdId) || existingIds.has(createdId)) throw new AppError('MUTATION_UNCERTAIN');
        const expected = {id:createdId,name:args.name,groupId:args.groupId,isIncome:args.expectedGroup.isIncome,hidden:false};
        const waitForReadback = async () => {
          const deadline = performance.now() + this.readbackTimeoutMs;
          while (true) {
            const current = await readCategoryCatalog(api,this.config); checkCreationGroup(current,args);
            const matches = current.categories.filter(row => row.groupId === args.groupId && sameCategoryName(row.name,args.name));
            const found = current.categories.find(row => row.id === createdId);
            if (found) {
              if (matches.length !== 1 || categoryFingerprint(args.context,found) !== categoryFingerprint(args.context,expected)) throw new AppError('MUTATION_UNCERTAIN');
              category = found; return;
            }
            if (matches.length || performance.now() >= deadline) throw new AppError('MUTATION_UNCERTAIN');
            await delay(Math.min(this.pollIntervalMs,Math.max(1,deadline-performance.now())));
          }
        };
        await waitForReadback(); await sync(); await waitForReadback();
        return {status:'applied',code:null,category,categoryFingerprint:categoryFingerprint(args.context,category),backupRef,verifiedAt:new Date().toISOString()};
      });
    } catch (error) {
      if (attempted) this.broken = true;
      return {status:attempted?'uncertain':'failed_before',code:attempted?'MUTATION_UNCERTAIN':errorCode(error,'ACTUAL_FAILED'),...(backupRef?{backupRef}:{}),...(category?{category}: {})};
    }
  }
  async changeCategory(input) {
    let args;
    try { args = validateChange(input); }
    catch { return { status: 'failed_before', code: 'INPUT_INVALID' }; }
    if (this.config.dryRun !== false) return { status: 'failed_before', code: 'MUTATION_DRY_RUN' };
    if (args.context.householdId !== this.config.householdId || args.context.budgetId !== this.config.actual.budgetId) return { status: 'failed_before', code: 'MUTATION_CONFLICT' };
    let attempted = false, before, after, backupRef;
    try {
      return await this.runExclusive(async api => {
        const sync = async () => { try { await api.sync(); } catch { throw new AppError('ACTUAL_SYNC_FAILED'); } };
        const check = inspection => {
          if (inspection.fingerprint !== args.expectedFingerprint) throw new AppError('MUTATION_CONFLICT');
          if (!inspection.eligibility.eligible) throw new AppError('MUTATION_INELIGIBLE');
          if (args.categoryId !== null && !inspection.categories.some(c => c.id === args.categoryId && !c.hidden && ['id', 'name', 'groupId', 'isIncome', 'hidden'].every(key => c[key] === args.expectedCategory[key]))) throw new AppError('MUTATION_CATEGORY_INVALID');
        };
        await sync();
        let inspection = await inspectCurrent(api, this.config, args.targetId);
        check(inspection); before = inspection.transaction;
        if (before.categoryId === args.categoryId) throw new AppError('MUTATION_CONFLICT');
        let bytes;
        try {
          bytes = await api.exportBudget();
          if (!(bytes instanceof Uint8Array) || bytes.length < 4 || Buffer.from(bytes.subarray(0, 4)).toString('hex') !== '504b0304') throw new AppError('BACKUP_FAILED');
          backupRef = await writeEncryptedBackup(bytes, { config: this.config, operationId: args.operationId, kind: 'actual', resolveSecret: this.resolveSecret });
        } catch { throw new AppError('BACKUP_FAILED'); }
        finally { bytes?.fill?.(0); }
        // Recheck after exporting/persisting: a remote client could have changed
        // the target or destination while the backup was being written.
        await sync(); inspection = await inspectCurrent(api, this.config, args.targetId); check(inspection);
        const expected = transactionFingerprint(args.context, { ...before, categoryId: args.categoryId });
        const waitForReadback = async () => {
          const deadline = performance.now() + this.readbackTimeoutMs;
          while (true) {
            after = await readTransaction(api, args.targetId);
            const fingerprint = transactionFingerprint(args.context, after);
            if (fingerprint === expected) return;
            // Only the identical old state can be eventual SDK completion.
            if (fingerprint !== args.expectedFingerprint || performance.now() >= deadline) throw new AppError('MUTATION_UNCERTAIN');
            await delay(Math.min(this.pollIntervalMs, Math.max(1, deadline - performance.now())));
          }
        };
        attempted = true;
        // Never use the return value as proof, and never repeat this patch.
        try {
          await api.updateTransaction(args.targetId, { category: args.categoryId });
          await waitForReadback(); await sync(); await waitForReadback();
        } catch (error) {
          // A partial/unawaited SDK mutation can outlive this callback. Block
          // queued direct executor calls; the client terminates its worker.
          this.broken = true;
          throw error;
        }
        return { status: 'applied', code: null, before, after, beforeFingerprint: args.expectedFingerprint, afterFingerprint: expected, backupRef, verifiedAt: new Date().toISOString() };
      });
    } catch (error) {
      return { status: attempted ? 'uncertain' : 'failed_before', code: attempted ? 'MUTATION_UNCERTAIN' : errorCode(error, 'ACTUAL_FAILED'), ...(before ? { before, beforeFingerprint: args.expectedFingerprint } : {}), ...(after ? { after, afterFingerprint: transactionFingerprint(args.context, after) } : {}), ...(backupRef ? { backupRef } : {}) };
    }
  }
  close() {
    if (!this.closing) {
      this.closed = true;
      this.closing = this.tail.then(async () => {
        try { if (this.initialized) await this.api.shutdown(); }
        catch { throw new AppError('ACTUAL_FAILED'); }
        finally { this.opened = false; this.initialized = false; }
      });
    }
    return this.closing;
  }
}
