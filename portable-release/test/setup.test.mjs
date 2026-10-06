import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readdir, chmod, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { inputConfig, tempDirectory } from './helpers.mjs';
import { validateConfig, loadConfig } from '../src/config.mjs';
import { configDiagnostic } from '../src/config-diagnostics.mjs';
import { createLogger } from '../src/observability/logger.mjs';
import { preflight } from '../src/preflight.mjs';
import { telegramSetupInfo } from '../src/telegram/setup-info.mjs';
import { StateStore } from '../src/storage/store.mjs';
import { identityFromConfig } from '../src/policy/authorize.mjs';

const canary = 'PRIVATE_CANARY_VALUE';
const failDiagnostic = (field, reason) => error => {
  assert.equal(error.message, 'CONFIG_INVALID');
  assert.deepEqual(configDiagnostic(error), { field, reason });
  assert.doesNotMatch(JSON.stringify([error, configDiagnostic(error)]), /CANARY/);
  return true;
};
async function fixture(t) {
  const root = tempDirectory(t), filename = path.join(root, 'config.json');
  const secrets = path.join(root, 'secrets');
  await mkdir(secrets); await mkdir(path.join(root, 'data', 'actual'), { recursive: true });
  await writeFile(path.join(secrets, 'telegram-token'), '123:' + canary, { mode: 0o600 });
  await writeFile(path.join(secrets, 'actual-password'), canary, { mode: 0o600 });
  const config = inputConfig();
  await writeFile(filename, JSON.stringify(config));
  return { root, secrets, filename, config, save: () => writeFile(filename, JSON.stringify(config)) };
}
test('config diagnostics identify fixed fields without source values or unknown keys', () => {
  const cases = [
    [c => c.actual.budgetId = 'REPLACE_' + canary, 'actual.budgetId', 'replace_placeholder'],
    [c => c.telegram.userId = canary, 'telegram.userId', 'expected_positive_integer'],
    [c => c.telegram.chatId = 456, 'telegram.chatId', 'private_chat_must_match_user'],
    [c => c.telegram[canary] = canary, 'telegram', 'unknown_field'],
    [c => c.actual.serverURL = 'https://user:' + canary + '@example.invalid', 'actual.serverURL', 'unsafe_url'],
    [c => c.actual.passwordRef = '../' + canary, 'actual.passwordRef', 'invalid_secret_reference'],
    [c => c.ollama = { url: 'http://example.invalid/?' + canary }, 'ollama.url', 'unsafe_url'],
    [c => c.ollama = { [canary]: canary }, 'ollama', 'unknown_field'],
    [c => c.categorization = { rules: [{ id: 'r', payeeId: 'p', categoryId: 'c', [canary]: canary }] }, 'categorization.rules', 'unknown_field'],
    [c => c.categorization = { rules: [{ id: 'r', payeeId: 'p', categoryId: '?' + canary }] }, 'categorization.rules.categoryId', 'invalid_identifier'],
    [c => c.secretDir = './data/' + canary, 'secretDir', 'directories_must_be_separate']
  ];
  for (const [change, field, reason] of cases) {
    const config = inputConfig(); change(config);
    assert.throws(() => validateConfig(config), failDiagnostic(field, reason));
  }
});
test('loadConfig preserves static diagnostics for JSON, missing and oversized files; accepts UTF-8 BOM', async t => {
  const root = tempDirectory(t), filename = path.join(root, canary + '.json');
  await assert.rejects(loadConfig(filename), failDiagnostic('configFile', 'file_missing'));
  await writeFile(filename, '{"' + canary + '":');
  await assert.rejects(loadConfig(filename), failDiagnostic('configFile', 'invalid_json'));
  await writeFile(filename, canary.repeat(4000));
  await assert.rejects(loadConfig(filename), failDiagnostic('configFile', 'file_too_large'));
  const config = inputConfig(); config.actual.budgetId = 'REPLACE_' + canary;
  await writeFile(filename, JSON.stringify(config));
  await assert.rejects(loadConfig(filename), failDiagnostic('actual.budgetId', 'replace_placeholder'));
  await writeFile(filename, '\uFEFF' + JSON.stringify(inputConfig()));
  assert.equal((await loadConfig(filename)).actual.budgetId, 'synthetic-budget');
  await assert.rejects(loadConfig(root), error => ['expected_file', 'file_unreadable'].includes(configDiagnostic(error)?.reason));
});
test('logger only exposes allowlisted config diagnostics for CONFIG_INVALID startup', () => {
  const lines = [], log = createLogger(line => lines.push(JSON.parse(line)));
  log('startup_failed', { code: 'CONFIG_INVALID', configField: 'actual.budgetId', configReason: 'replace_placeholder', error: canary, value: canary });
  assert.equal(lines[0].configField, 'actual.budgetId');
  for (const extra of [
    { configField: canary, configReason: 'invalid_identifier' },
    { configField: 'actual.budgetId', configReason: canary },
    { configField: 'actual.budgetId', configReason: 'replace_placeholder', code: 'NETWORK_FAILED' }
  ]) log('startup_failed', { code: 'CONFIG_INVALID', ...extra });
  log('job_failed', { code: 'CONFIG_INVALID', configField: 'actual.budgetId', configReason: 'replace_placeholder' });
  for (const line of lines.slice(1)) assert.equal(line.configField, undefined);
  assert.doesNotMatch(JSON.stringify(lines), /CANARY/);
});
test('state and bot binding failures retain protection and gain static diagnostics', t => {
  const root = tempDirectory(t), filename = path.join(root, 'state.sqlite');
  const identity = identityFromConfig(validateConfig(inputConfig()));
  const original = new StateStore(filename, identity); original.bindTelegramBot(789); original.close();
  assert.throws(() => new StateStore(filename, { ...identity, budgetId: canary }), failDiagnostic('state', 'state_identity_mismatch'));
  const reopened = new StateStore(filename, identity);
  try {
    assert.throws(() => reopened.bindTelegramBot(456), failDiagnostic('state', 'bot_identity_mismatch'));
    reopened.bindTelegramBot(789);
  } finally { reopened.close(); }
});
test('offline preflight checks required mounted secrets and leaves storage untouched', async t => {
  const f = await fixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('PREFLIGHT_NETWORK_FORBIDDEN'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await preflight(f.filename);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(await readdir(path.join(f.root, 'data')), ['actual']);
  assert.deepEqual(await readdir(path.join(f.root, 'data', 'actual')), []);
  assert.doesNotMatch(JSON.stringify(result), /CANARY|synthetic-budget|localhost|telegram-token|actual-password/);
  assert.equal(result.checks.some(check => check.field === 'backup.keyRef'), false);
  f.config.actual.encryptionPasswordRef = 'encryption-key'; await f.save();
  assert.equal((await preflight(f.filename)).checks.find(check => check.field === 'actual.encryptionPasswordRef').reason, 'secret_unavailable');
});
test('preflight requires backup key for writes and validates configured keys even in dry run', async t => {
  const f = await fixture(t); f.config.dryRun = false; await f.save();
  assert.equal((await preflight(f.filename)).checks.find(check => check.field === 'backup.keyRef').reason, 'backup_key_required_for_writes');
  f.config.dryRun = true; f.config.backup = { keyRef: 'backup-key' }; await f.save();
  await writeFile(path.join(f.secrets, 'backup-key'), canary, { mode: 0o600 });
  assert.equal((await preflight(f.filename)).checks.find(check => check.field === 'backup.keyRef').reason, 'secret_format_invalid');
  await writeFile(path.join(f.secrets, 'backup-key'), 'ab'.repeat(32));
  assert.equal((await preflight(f.filename)).ok, true);
  assert.deepEqual(await readdir(path.join(f.root, 'data')), ['actual']);
});
test('preflight reports missing directory, malformed token and unsafe POSIX secret mode safely', async t => {
  const f = await fixture(t); f.config.dataDir = './' + canary; await f.save();
  let result = await preflight(f.filename);
  assert.equal(result.checks.find(check => check.field === 'dataDir').reason, 'directory_missing');
  assert.doesNotMatch(JSON.stringify(result), /CANARY/);
  await writeFile(path.join(f.secrets, 'telegram-token'), canary);
  result = await preflight(f.filename);
  assert.equal(result.checks.find(check => check.field === 'telegram.tokenRef').reason, 'secret_format_invalid');
  if (process.platform !== 'win32') {
    await chmod(path.join(f.secrets, 'actual-password'), 0o644);
    result = await preflight(f.filename);
    assert.equal(result.checks.find(check => check.field === 'actual.passwordRef').reason, 'secret_permissions');
  }
});
test('CLI and real main startup report safe static diagnostics and useful exit codes', async t => {
  const f = await fixture(t);
  const child = (script, args = [], env = {}) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15000 });
  let result = child('scripts/preflight.mjs', [f.filename]);
  assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /preflight_ok/);
  result = child('scripts/preflight.mjs', ['--' + canary]);
  assert.equal(result.status, 2); assert.doesNotMatch(result.stdout + result.stderr, /CANARY/);
  f.config.actual.budgetId = 'REPLACE_' + canary; await f.save();
  for (const script of ['scripts/preflight.mjs', 'src/main.mjs']) {
    result = child(script, [], { CONFIG_FILE: f.filename });
    assert.ifError(result.error); assert.equal(result.status, 1); assert.match(result.stdout, /actual.budgetId/); assert.match(result.stdout, /replace_placeholder/);
    assert.doesNotMatch(result.stdout + result.stderr, /CANARY/);
  }
});
test('Telegram setup uses only read calls without offset/subscription changes and returns private IDs', async t => {
  const f = await fixture(t), requests = [];
  const updates = [
    { message: { from: { id: 123, is_bot: false, first_name: canary }, chat: { id: 123, type: 'private' }, text: canary } },
    { message: { from: { id: 456, is_bot: false }, chat: { id: 456, type: 'private' } } },
    { message: { from: { id: 789, is_bot: true }, chat: { id: 789, type: 'private' } } },
    { message: { from: { id: 123, is_bot: false }, chat: { id: -123, type: 'group' } } },
    { message: { from: { id: 123, is_bot: false }, chat: { id: 222, type: 'private' } } }
  ];
  const fetchImpl = async (url, options) => {
    const method = url.split('/').at(-1); requests.push([method, JSON.parse(options.body)]);
    return Response.json({ ok: true, result: method === 'getMe' ? { id: 999, is_bot: true, username: canary } : method === 'getWebhookInfo' ? { url: '', last_error_message: canary } : updates });
  };
  const result = await telegramSetupInfo({ secretDir: f.secrets, fetchImpl });
  assert.deepEqual(requests, [['getMe', {}], ['getWebhookInfo', {}], ['getUpdates', { timeout: 0, limit: 100 }]]);
  assert.deepEqual(result.candidates, [{ userId: 123, chatId: 123 }, { userId: 456, chatId: 456 }]);
  assert.doesNotMatch(JSON.stringify(result), /CANARY/);
});
test('Telegram setup blocks active webhook and redacts integration/network failures', async t => {
  const f = await fixture(t), methods = [];
  const webhook = await telegramSetupInfo({ secretDir: f.secrets, fetchImpl: async url => {
    const method = url.split('/').at(-1); methods.push(method);
    return Response.json({ ok: true, result: method === 'getMe' ? { id: 999, is_bot: true } : { url: 'https://' + canary + '.invalid' } });
  } });
  assert.equal(webhook.code, 'TELEGRAM_WEBHOOK_ACTIVE'); assert.deepEqual(methods, ['getMe', 'getWebhookInfo']);
  const network = await telegramSetupInfo({ secretDir: f.secrets, fetchImpl: async () => { throw new Error('https://api.telegram.org/bot' + canary); } });
  assert.equal(network.code, 'NETWORK_FAILED');
  const maliciousRef = await telegramSetupInfo({ secretDir: f.secrets, tokenRef: '../' + canary });
  assert.equal(maliciousRef.code, 'SECRET_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify([webhook, network, maliciousRef]), /CANARY/);
});
test('Telegram setup bounds the pending page and never infers ownership from one result', async t => {
  const f = await fixture(t);
  const run = updates => telegramSetupInfo({ secretDir: f.secrets, fetchImpl: async url => Response.json({ ok: true,
    result: url.endsWith('/getMe') ? { id: 999, is_bot: true } : url.endsWith('/getWebhookInfo') ? { url: '' } : updates }) });
  const limit = await run(Array(100).fill({ message: { from: { id: 123, is_bot: false }, chat: { id: 123, type: 'private' } } }));
  assert.equal(limit.updatesAtLimit, true); assert.equal(limit.reason, 'first_100_updates_only_do_not_assume_owner');
  assert.deepEqual(limit.candidates, [{ userId: 123, chatId: 123 }]);
  assert.equal((await run(Array(101).fill({}))).code, 'TELEGRAM_REJECTED');
  assert.equal((await run([])).reason, 'send_start_in_private_chat_then_retry');
});
test('Docker example matches shipped mount paths and scripts; Compose fails on absent bind sources', async () => {
  const example = JSON.parse(await readFile('config.docker.example.json', 'utf8'));
  assert.equal(example.dataDir, '/data'); assert.equal(example.secretDir, '/run/secrets');
  assert.equal(example.dryRun, true); assert.equal(example.ollama.enabled, false);
  example.actual.budgetId = 'synthetic-budget'; assert.doesNotThrow(() => validateConfig(example));
  const compose = await readFile('compose.yaml', 'utf8');
  assert.equal((compose.match(/create_host_path: false/g) ?? []).length, 2);
  assert.match(compose, /target: \/app\/config.json/); assert.match(compose, /target: \/run\/secrets/);
  const dockerfile = await readFile('Dockerfile', 'utf8');
  assert.match(dockerfile, /COPY scripts\/health.mjs scripts\/preflight.mjs scripts\/telegram-info.mjs scripts\/setup-docker.mjs \.\/scripts\//);
});
