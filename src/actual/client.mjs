import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { validatePeriod } from './snapshot.mjs';
import { validateChange, validId } from './transaction.mjs';

// Only domain operations cross this boundary; never forward SDK method names.
export class ActualClient {
  #config;
  #createWorker;
  #state = null;
  #tail = Promise.resolve();
  #closing = null;
  #unusable = false;

  constructor(config, { createWorker = (url, options) => new Worker(url, options) } = {}) {
    this.#config = structuredClone({
      householdId: config.householdId, dataDir: config.dataDir, secretDir: config.secretDir,
      timezone: config.timezone, currency: config.currency, actual: config.actual,
      dryRun: config.dryRun, backup: config.backup
    });
    this.#createWorker = createWorker;
  }

  #worker() {
    if (this.#state) return this.#state;
    if (this.#unusable) throw new AppError('ACTUAL_FAILED');
    let worker;
    try {
      worker = this.#createWorker(new URL('./worker.mjs', import.meta.url), {
        workerData: this.#config, stdout: true, stderr: true
      });
    } catch { throw new AppError('ACTUAL_FAILED'); }
    const state = { worker, active: null, stopping: null };
    this.#state = state;
    // Drain rather than relay SDK diagnostics (including logs before import).
    worker.stdout?.resume();
    worker.stderr?.resume();
    worker.on('message', message => {
      const request = state.active;
      if (!request || state.stopping || message?.id !== request.id) return;
      state.active = null;
      clearTimeout(request.timer);
      if (request.operation === 'changeCategory' && message.result?.status === 'uncertain') {
        // The SDK may still be applying an unawaited update after its domain
        // readback deadline. Retire this owner before releasing the queue,
        // retaining the journal/backup evidence from the uncertain result.
        void this.#stop(state, 'MUTATION_UNCERTAIN').then(() => request.resolve(message.result));
        return;
      }
      message.code ? request.reject(new AppError(message.code)) : request.resolve(message.result);
    });
    worker.on('error', () => { void this.#stop(state, 'ACTUAL_FAILED'); });
    worker.on('exit', () => { void this.#stop(state, 'ACTUAL_FAILED'); });
    return state;
  }

  #stop(state, code) {
    if (state.stopping) return state.stopping;
    const request = state.active;
    state.active = null;
    if (request) clearTimeout(request.timer);
    // Defer termination until stopping is assigned: termination can emit exit.
    state.stopping = Promise.resolve().then(async () => {
      try { await state.worker.terminate(); }
      catch { this.#unusable = true; }
      if (this.#state === state) this.#state = null;
      // Rejection happens AFTER termination, so the next queued lifecycle can
      // never open the same SDK cache while an expired worker still owns it.
      if (request?.operation === 'changeCategory') request.resolve({ status: 'uncertain', code: 'MUTATION_UNCERTAIN' });
      else request?.reject(new AppError(code));
    });
    return state.stopping;
  }

  async #request(operation, args) {
    if (this.#state?.stopping) await this.#state.stopping;
    const state = this.#worker();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { void this.#stop(state, 'ACTUAL_TIMEOUT'); }, this.#config.actual.timeoutMs);
      state.active = { id, operation, resolve, reject, timer };
      try { state.worker.postMessage({ id, operation, args }); }
      catch { void this.#stop(state, 'ACTUAL_FAILED'); }
    });
  }

  snapshot(period) {
    if (this.#closing) return Promise.reject(new AppError('SHUTTING_DOWN'));
    try { validatePeriod(period); } catch (error) { return Promise.reject(error); }
    const input = { start: period.start, end: period.end };
    const task = this.#tail.then(() => this.#request('snapshot', input));
    this.#tail = task.catch(() => {});
    return task;
  }

  inspectTransaction(targetId) {
    if (this.#closing) return Promise.reject(new AppError('SHUTTING_DOWN'));
    if (!validId(targetId)) return Promise.reject(new AppError('INPUT_INVALID'));
    const task = this.#tail.then(() => this.#request('inspectTransaction', targetId));
    this.#tail = task.catch(() => {});
    return task;
  }

  changeCategory(input) {
    let args;
    try { args = validateChange(input); }
    catch { return Promise.resolve({ status: 'failed_before', code: 'INPUT_INVALID' }); }
    if (this.#closing) return Promise.resolve({ status: 'failed_before', code: 'SHUTTING_DOWN' });
    if (this.#config.dryRun !== false) return Promise.resolve({ status: 'failed_before', code: 'MUTATION_DRY_RUN' });
    const task = this.#tail.then(() => this.#request('changeCategory', args)).catch(() => ({ status: 'uncertain', code: 'MUTATION_UNCERTAIN' }));
    this.#tail = task.catch(() => {});
    return task;
  }

  close() {
    if (!this.#closing) {
      this.#closing = this.#tail.then(async () => {
        try { if (this.#state && !this.#state.stopping) await this.#request('close'); }
        finally { if (this.#state) await this.#stop(this.#state, 'SHUTTING_DOWN'); }
      });
    }
    return this.#closing;
  }
}
