import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { AppError, errorCode } from '../errors.mjs';
import { normalizeSnapshot, validatePeriod, validMonth } from './snapshot.mjs';

// Owns the SDK's global lifecycle. Production creates exactly one in its worker.
// Tests inject an SDK-shaped fake; no model-facing arbitrary method dispatch exists.
export class ActualExecutor {
  constructor({ api, config, resolveSecret }) {
    this.api = api;
    this.config = config;
    this.resolveSecret = resolveSecret;
    this.tail = Promise.resolve();
    this.opened = false;
    this.initialized = false;
    this.closed = false;
    this.broken = false;
    this.closing = null;
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
      let accounts, categories, payees, budgetMonths;
      try {
        accounts = await api.getAccounts();
        categories = await api.getCategories({ hidden: true });
        payees = await api.getPayees();
        const months = await api.getBudgetMonths();
        if (![accounts, categories, payees, months].every(Array.isArray) || !months.every(validMonth) || new Set(months).size !== months.length) throw new AppError('SNAPSHOT_INVALID');
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
      return normalizeSnapshot({ config: this.config, period, accounts: withBalances, categories, payees, transactions, budgetMonths, syncedAt, failedAccountIds });
    });
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
