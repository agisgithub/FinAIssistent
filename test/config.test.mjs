import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, chmod, symlink } from 'node:fs/promises';
import path from 'node:path';
import { validateConfig, loadConfig } from '../src/config.mjs';
import { secretResolver } from '../src/secrets/resolver.mjs';
import { createLogger } from '../src/observability/logger.mjs';
import { AppError, errorCode } from '../src/errors.mjs';
import { inputConfig, tempDirectory } from './helpers.mjs';

test('config defaults are local-only, immutable and path-relative', () => {
  const config = validateConfig(inputConfig());
  assert.equal(config.privacy.externalProviders, false);
  assert.equal(config.dryRun, true);
  assert.equal(config.currency, 'BRL');
  assert.equal(config.timezone, 'America/Sao_Paulo');
  assert.ok(path.isAbsolute(config.dataDir));
  assert.throws(() => { config.telegram.userId = 999; }, TypeError);
});

test('settings reject unsafe or ambiguous identity, endpoints, secrets and limits', () => {
  const changes = [
    c => c.telegram.userId = 0, c => c.telegram.chatId = 999,
    c => c.telegram.token = 'CANARY_SECRET', c => c.actual.password = 'CANARY_SECRET',
    c => c.actual.passwordRef = '../escape', c => c.actual.budgetId = 'REPLACE_WITH_SYNC_ID',
    c => c.actual.serverURL = 'https://user:CANARY_SECRET@example.com',
    c => c.actual.serverURL = 'https://example.com?token=CANARY_SECRET',
    c => c.actual.serverURL = 'file:///secret', c => c.timezone = 'bad-zone',
    c => c.currency = 'USD', c => c.dryRun = 'false', c => c.actual.timeoutMs = Infinity,
    c => c.privacy = { externalProviders: true }, c => c.secretDir = './data/secrets',
    c => c.retentionDays = -1, c => c.unrecognized = true
  ];
  for (const change of changes) {
    const input = inputConfig(); change(input);
    assert.throws(() => validateConfig(input), error => error.message === 'CONFIG_INVALID' && !JSON.stringify(error).includes('CANARY'));
  }
});

test('malformed config never returns raw JSON or source path', async t => {
  const filename = path.join(tempDirectory(t), 'bad.json');
  await writeFile(filename, '{"token":"CANARY_SECRET",');
  await assert.rejects(loadConfig(filename), error => error.message === 'CONFIG_INVALID' && !error.message.includes(filename));
});

test('mounted secrets reject traversal and multi-line values', async t => {
  const root = tempDirectory(t);
  const secrets = path.join(root, 'secrets'); await mkdir(secrets);
  const filename = path.join(secrets, 'token');
  await writeFile(filename, 'CANARY_SECRET\n', { mode: 0o600 });
  const resolveSecret = secretResolver(secrets);
  assert.equal(await resolveSecret('token'), 'CANARY_SECRET');
  for (const invalid of ['../token', '/token', 'C:\\token', 'token.txt', 'missing']) await assert.rejects(resolveSecret(invalid), /SECRET_UNAVAILABLE/);
  await writeFile(filename, 'CANARY_SECRET\nSECOND_LINE');
  await assert.rejects(resolveSecret('token'), /SECRET_UNAVAILABLE/);
});

test('POSIX mounted secrets reject unsafe modes and symlinks', { skip: process.platform === 'win32' ? 'POSIX modes and symlinks require the Linux CI job; Windows ACLs are an operator check.' : false }, async t => {
  const root = tempDirectory(t);
  const filename = path.join(root, 'token');
  const resolveSecret = secretResolver(root);
  await writeFile(filename, 'secret', { mode: 0o600 }); await chmod(filename, 0o644);
  await assert.rejects(resolveSecret('token'), /SECRET_PERMISSIONS/);
  await symlink(filename, path.join(root, 'link'));
  await assert.rejects(resolveSecret('link'), /SECRET_UNAVAILABLE/);
});

test('logger allowlist strips financial text, arbitrary errors, URLs and secret canaries', () => {
  const output = [];
  const logger = createLogger(line => output.push(line));
  logger('CANARY_SECRET', { code: 'CANARY_SECRET', token: 'CANARY_SECRET', integration: 'CANARY_SECRET', jobId: 'CANARY_SECRET', durationMs: -1, error: new Error('CANARY_SECRET'), url: 'https://user:CANARY_SECRET@host', amount: 12300, text: 'Rent payment' });
  logger('job_failed', { code: errorCode(new Error('CANARY_SECRET')), jobId: 'dcd9eae4-8743-4d27-b877-123456789012', durationMs: 12 });
  assert.equal(output.join('').includes('CANARY_SECRET'), false);
  assert.deepEqual(Object.keys(JSON.parse(output[0])).sort(), ['at', 'event']);
  assert.equal(JSON.parse(output[1]).code, 'INTERNAL_ERROR');
  assert.equal(errorCode(new AppError('NOT_ALLOWED')), 'INTERNAL_ERROR');
});
