import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { addActualBase } from '../src/setup/actual-base.mjs';
import { inputConfig, tempDirectory } from './helpers.mjs';

test('server-side base configurator copies only the sync id and secret reference', async t => {
  const root = tempDirectory(t), configFile = path.join(root, 'config.json'), sourceFile = path.join(root, 'hml.json');
  await writeFile(configFile, JSON.stringify(inputConfig()), { mode: 0o600 });
  await writeFile(sourceFile, JSON.stringify({ sync_id: 'HML_SYNC_CANARY', password: 'MUST_NOT_COPY' }), { mode: 0o600 });
  if (process.platform !== 'win32') { await chmod(configFile, 0o600); await chmod(sourceFile, 0o600); }
  const result = await addActualBase({ configFile, sourceFile, alias: 'financa-hml2', serverURL: 'http://host.docker.internal:5007' });
  assert.deepEqual(result, { status: 'updated', alias: 'financa-hml2' });
  assert.doesNotMatch(JSON.stringify(result), /HML_SYNC_CANARY|MUST_NOT_COPY/);
  const saved = JSON.parse(await readFile(configFile, 'utf8'));
  assert.equal(saved.actual.defaultBase, 'principal');
  assert.equal(saved.actual.bases['financa-hml2'].budgetId, 'HML_SYNC_CANARY');
  assert.equal(saved.actual.bases['financa-hml2'].passwordRef, 'actual-password');
  assert.equal(saved.actual.bases['financa-hml2'].encryptionPasswordRef, null);
  assert.equal(JSON.stringify(saved).includes('MUST_NOT_COPY'), false);
  assert.deepEqual(await addActualBase({ configFile, sourceFile, alias: 'financa-hml2', serverURL: 'http://host.docker.internal:5007' }), { status: 'unchanged', alias: 'financa-hml2' });
});

test('server-side base configurator rejects conflicting underscore sync ids without exposing either value', async t => {
  const root = tempDirectory(t), configFile = path.join(root, 'config.json'), sourceFile = path.join(root, 'hml.json');
  await writeFile(configFile, JSON.stringify(inputConfig()), { mode: 0o600 });
  await writeFile(sourceFile, JSON.stringify({ sync_id: 'TOP_LEVEL_CANARY', actual: { sync_id: 'NESTED_CANARY' } }), { mode: 0o600 });
  if (process.platform !== 'win32') { await chmod(configFile, 0o600); await chmod(sourceFile, 0o600); }
  await assert.rejects(
    addActualBase({ configFile, sourceFile, alias: 'financa-hml2', serverURL: 'http://host.docker.internal:5007' }),
    error => error?.message === 'ACTUAL_BASE_CONFIG_FAILED' && error?.reason === 'budget_id_unavailable' && !JSON.stringify(error).includes('CANARY')
  );
  const saved = JSON.parse(await readFile(configFile, 'utf8'));
  assert.equal(saved.actual.budgetId, 'synthetic-budget');
  assert.equal(saved.actual.bases, undefined);
});
