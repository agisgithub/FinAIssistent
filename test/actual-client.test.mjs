import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ActualClient } from '../src/actual/client.mjs';

const period = { start: '2026-09-01', end: '2026-09-30' };
const config = { householdId: 'test', dataDir: '/test-data', secretDir: '/test-secrets', timezone: 'America/Sao_Paulo', currency: 'BRL', telegram: { tokenRef: 'not-for-actual' }, actual: { budgetId: 'synthetic', passwordRef: 'actual-password', timeoutMs: 1000 } };
class FakeWorker extends EventEmitter {
  messages = [];
  stdout = { resume() {} };
  stderr = { resume() {} };
  postMessage(message) { this.messages.push(message); }
  respond(result = 'ok') { this.emit('message', { id: this.messages.at(-1).id, result }); }
  async terminate() { this.emit('exit', 0); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('ActualClient queues snapshots, sends only secret references and closes once', async () => {
  let worker, options, created = 0;
  const client = new ActualClient(config, { createWorker(url, received) { options = received; created++; return worker = new FakeWorker(); } });
  assert.equal(client.request, undefined);
  assert.equal(created, 0, 'lazy SDK owner');
  const first = client.snapshot(period), second = client.snapshot(period);
  await tick();
  assert.equal(worker.messages.length, 1);
  assert.equal(options.workerData.telegram, undefined);
  assert.equal(options.workerData.actual.password, undefined);
  assert.equal(options.workerData.actual.passwordRef, 'actual-password');
  assert.deepEqual(worker.messages[0].args, period);
  worker.respond('first');
  assert.equal(await first, 'first');
  await tick();
  assert.equal(worker.messages.length, 2);
  worker.respond('second');
  assert.equal(await second, 'second');
  const closing = client.close();
  assert.equal(closing, client.close());
  await assert.rejects(client.snapshot(period), { code: 'SHUTTING_DOWN' });
  await tick();
  assert.equal(worker.messages.at(-1).operation, 'close');
  worker.respond();
  await closing;
  assert.equal(created, 1);
});

test('timeout awaits worker termination before rejecting or opening a replacement cache owner', async () => {
  let finishTermination, announceTermination;
  const terminationStarted = new Promise(resolve => { announceTermination = resolve; });
  const terminationFinished = new Promise(resolve => { finishTermination = resolve; });
  const workers = [];
  const client = new ActualClient({ ...config, actual: { ...config.actual, timeoutMs: 20 } }, {
    createWorker() {
      const worker = new FakeWorker();
      if (workers.length === 0) worker.terminate = async () => { announceTermination(); await terminationFinished; worker.emit('exit', 1); };
      else worker.postMessage = message => { worker.messages.push(message); queueMicrotask(() => worker.respond()); };
      workers.push(worker); return worker;
    }
  });
  let rejected = false;
  const first = client.snapshot(period).catch(error => { rejected = true; return error; });
  const second = client.snapshot(period);
  await terminationStarted;
  assert.equal(rejected, false);
  assert.equal(workers.length, 1);
  workers[0].respond('late ignored response');
  assert.equal(rejected, false);
  finishTermination();
  assert.equal((await first).code, 'ACTUAL_TIMEOUT');
  assert.equal(await second, 'ok');
  assert.equal(workers.length, 2);
  await client.close();
});

test('schedule reads use closed RPC, queue with snapshots and await retirement on timeout', async () => {
  let finishTermination, announceTermination;
  const terminating = new Promise(resolve => { announceTermination = resolve; });
  const retired = new Promise(resolve => { finishTermination = resolve; });
  const workers = [];
  const client = new ActualClient({ ...config, actual: { ...config.actual, timeoutMs: 20 } }, { createWorker() {
    const worker = new FakeWorker();
    if (!workers.length) worker.terminate = async () => { announceTermination(); await retired; worker.emit('exit', 1); };
    else worker.postMessage = message => { worker.messages.push(message); queueMicrotask(() => worker.respond('fresh')); };
    workers.push(worker); return worker;
  } });
  const first = client.readSchedules().catch(error => error), second = client.snapshot(period);
  await terminating;
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages[0].operation, 'readSchedules');
  assert.equal(workers[0].messages[0].args, undefined);
  finishTermination();
  assert.equal((await first).code, 'ACTUAL_TIMEOUT'); assert.equal(await second, 'fresh');
  assert.equal(workers.length, 2);
  await client.close();
  await assert.rejects(client.readSchedules(), { code: 'SHUTTING_DOWN' });
  assert.equal(client.getSchedules, undefined); assert.equal(client.createSchedule, undefined);
});

test('worker crash and malformed error text never leak; failed termination prevents replacement', async () => {
  let worker, created = 0;
  const client = new ActualClient(config, { createWorker() {
    created++;
    worker = new FakeWorker();
    worker.terminate = async () => { throw new Error('secret termination details'); };
    return worker;
  } });
  const first = client.snapshot(period);
  const assertion = assert.rejects(first, { message: 'ACTUAL_FAILED', code: 'ACTUAL_FAILED' });
  await tick();
  worker.emit('error', new Error('password=secret; account balance 123456'));
  await assertion;
  await assert.rejects(client.snapshot(period), { code: 'ACTUAL_FAILED' });
  assert.equal(created, 1);
  await client.close();
});

test('invalid periods fail before any worker or SDK starts', async () => {
  const client = new ActualClient(config, { createWorker() { assert.fail('SDK must not start'); } });
  await assert.rejects(client.snapshot({ start: '2026-02-30', end: '2026-03-01' }), { code: 'INPUT_INVALID' });
  await assert.rejects(client.snapshot({ ...period, method: 'deleteBudget' }), { code: 'INPUT_INVALID' });
  await client.close();
});
