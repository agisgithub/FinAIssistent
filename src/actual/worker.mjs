import { parentPort, workerData } from 'node:worker_threads';
import { ActualExecutor } from './executor.mjs';
import { secretResolver } from '../secrets/resolver.mjs';
import { AppError, errorCode } from '../errors.mjs';
import { loadPinnedActual } from './sdk-loader.mjs';

// SDK can write diagnostics independently of its verbose flag. Suppress its
// stdout/stderr in this isolated worker before importing it; never relay raw logs.
process.stdout.write = () => true;
process.stderr.write = () => true;
const api = await loadPinnedActual();
const executor = new ActualExecutor({ api, config: workerData, resolveSecret: secretResolver(workerData.secretDir) });
parentPort.on('message', async message => {
  try {
    let result;
    if (message.operation === 'snapshot') result = await executor.snapshot(message.args);
    else if (message.operation === 'monthlySpendingSeries') result = await executor.monthlySpendingSeries(message.args);
    else if (message.operation === 'readSchedules') result = await executor.readSchedules();
    else if (message.operation === 'inspectTransaction') result = await executor.inspectTransaction(message.args);
    else if (message.operation === 'changeCategory') result = await executor.changeCategory(message.args);
    else if (message.operation === 'inspectCategoryCatalog') result = await executor.inspectCategoryCatalog();
    else if (message.operation === 'createCategory') result = await executor.createCategory(message.args);
    else if (message.operation === 'close') result = await executor.close();
    else throw new AppError('INPUT_INVALID');
    parentPort.postMessage({ id: message.id, result });
  } catch (error) { parentPort.postMessage({ id: message.id, code: errorCode(error, 'ACTUAL_FAILED') }); }
});
