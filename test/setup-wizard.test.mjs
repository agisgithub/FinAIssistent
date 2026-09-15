import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inputConfig, tempDirectory } from './helpers.mjs';
import { runDockerSetup, commitSetup } from '../src/setup/wizard.mjs';
import { SetupCancelled } from '../src/setup/terminal.mjs';
import { validateConfig } from '../src/config.mjs';

const token = '123:WIZARD_CANARY_TOKEN';
const password = '  WIZARD_CANARY "quote" \\ $HOME $(touch bad) `id`  ';
const owner = process.getuid?.() ?? 1000;
function fakeIO(answers) {
  const transcript = [], pending = [...answers];
  return { transcript, pending, write: value => transcript.push(value), check() {}, async ask(prompt, options = {}) {
    transcript.push(prompt); const answer = pending.shift();
    if (answer instanceof Error || answer === undefined) throw new SetupCancelled();
    if (!options.secret) transcript.push(answer);
    return answer;
  } };
}
const info = async () => ({ event: 'telegram_info_ok', updatesAtLimit: false, candidates: [{ userId: 123, chatId: 123 }] });
const freshAnswers = (save = 's', writes = '') => ['', 'synthetic-budget', token, password, '', '', 's', '', writes, save];
async function fixture(t, config = inputConfig()) {
  const root = tempDirectory(t);
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config));
  await fs.mkdir(path.join(root, 'secrets'), { mode: 0o700 });
  await fs.writeFile(path.join(root, 'secrets', 'telegram-token'), token + '\n', { mode: 0o600 });
  await fs.writeFile(path.join(root, 'secrets', 'actual-password'), password + '\n', { mode: 0o600 });
  await fs.mkdir(path.join(root, 'data')); await fs.writeFile(path.join(root, 'data', 'state.sqlite'), 'FINANCIAL_SENTINEL');
  return root;
}
test('wizard creates escaped Docker config and private secrets without echoing values', async t => {
  const root = tempDirectory(t), io = fakeIO(freshAnswers());
  assert.equal((await runDockerSetup({ root, io, owner, telegramInfo: info })).status, 'saved');
  assert.equal(io.pending.length, 0);
  const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
  assert.equal(config.dataDir, '/data'); assert.equal(config.secretDir, '/run/secrets'); assert.equal(config.dryRun, true);
  assert.doesNotThrow(() => validateConfig(config));
  assert.equal(await fs.readFile(path.join(root, 'secrets', 'actual-password'), 'utf8'), password + '\n');
  assert.doesNotMatch(JSON.stringify(io.transcript), /CANARY/);
  assert.deepEqual(await fs.readdir(path.join(root, '.setup-private')), ['backups']);
  if (process.platform !== 'win32') for (const filename of ['config.json', 'secrets/actual-password']) {
    const stat = await fs.stat(path.join(root, filename)); assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.uid, owner);
  }
});
test('cancel or EOF at each prompt leaves existing config, secrets and financial files untouched', async t => {
  const answers = ['', '', '', '', '', '', 's', '', '', 's'];
  for (let stop = 0; stop < answers.length; stop++) {
    const root = await fixture(t), before = await fs.readFile(path.join(root, 'config.json'));
    const io = fakeIO(answers.slice(0, stop));
    assert.equal((await runDockerSetup({ root, io, owner, telegramInfo: info })).status, 'cancelled');
    assert.deepEqual(await fs.readFile(path.join(root, 'config.json')), before);
    assert.equal(await fs.readFile(path.join(root, 'secrets', 'actual-password'), 'utf8'), password + '\n');
    assert.equal(await fs.readFile(path.join(root, 'data', 'state.sqlite'), 'utf8'), 'FINANCIAL_SENTINEL');
    assert.equal(await fs.stat(path.join(root, '.setup-private')).then(() => true, () => false), false);
    assert.doesNotMatch(JSON.stringify(io.transcript), /CANARY/);
  }
});
test('rerun Enter preserves references, secret bytes, unrelated settings and backup key', async t => {
  const config = { ...inputConfig(), retentionDays: 25, backup: { keyRef: 'custom-backup' }, categorization: { rules: [{ id: 'r', payeeId: 'p', categoryId: 'c' }] } };
  config.telegram.tokenRef = 'custom-token'; config.actual.passwordRef = 'custom-password';
  const root = await fixture(t, config);
  await fs.rename(path.join(root, 'secrets', 'telegram-token'), path.join(root, 'secrets', 'custom-token'));
  await fs.rename(path.join(root, 'secrets', 'actual-password'), path.join(root, 'secrets', 'custom-password'));
  await fs.writeFile(path.join(root, 'secrets', 'custom-backup'), 'ab'.repeat(32) + '\n', { mode: 0o600 });
  const io = fakeIO(['', '', '', '', '', '', 's', '', '', 's']);
  assert.equal((await runDockerSetup({ root, io, owner, telegramInfo: info })).status, 'saved');
  const saved = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
  assert.equal(saved.retentionDays, 25); assert.deepEqual(saved.categorization, config.categorization);
  assert.equal(saved.telegram.tokenRef, 'custom-token'); assert.equal(saved.actual.passwordRef, 'custom-password');
  assert.equal(await fs.readFile(path.join(root, 'secrets', 'custom-password'), 'utf8'), password + '\n');
  assert.equal(await fs.readFile(path.join(root, 'secrets', 'custom-backup'), 'utf8'), 'ab'.repeat(32) + '\n');
  const backups = await fs.readdir(path.join(root, '.setup-private', 'backups'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, '.setup-private', 'backups', backups[0], 'config.json'), 'utf8')), config);
});
test('writing opt-in generates a key once and preserves it on rerun', async t => {
  const root = tempDirectory(t), io = fakeIO(freshAnswers('s', 's'));
  assert.equal((await runDockerSetup({ root, io, owner, telegramInfo: info })).status, 'saved');
  const key = await fs.readFile(path.join(root, 'secrets', 'backup-key'), 'utf8'); assert.match(key, /^[a-f0-9]{64}\n$/);
  const rerun = fakeIO(['', '', '', '', '', '', 's', '', '', 's']);
  assert.equal((await runDockerSetup({ root, io: rerun, owner, telegramInfo: info })).status, 'saved');
  assert.equal(await fs.readFile(path.join(root, 'secrets', 'backup-key'), 'utf8'), key);
  assert.doesNotMatch(JSON.stringify([io.transcript, rerun.transcript]), new RegExp(key.trim()));
});
test('malformed JSON, unknown fields and symlink targets fail before prompts or writes', async t => {
  for (const content of ['{"PRIVATE_CANARY":', JSON.stringify({ ...inputConfig(), PRIVATE_CANARY: 'PRIVATE_CANARY' })]) {
    const root = tempDirectory(t); await fs.writeFile(path.join(root, 'config.json'), content);
    const io = fakeIO([]); assert.equal((await runDockerSetup({ root, io, owner, telegramInfo: info })).status, 'failed');
    assert.equal(await fs.readFile(path.join(root, 'config.json'), 'utf8'), content); assert.doesNotMatch(JSON.stringify(io.transcript), /CANARY/);
  }
  if (process.platform !== 'win32') {
    const root = tempDirectory(t), destination = path.join(root, 'original'); await fs.writeFile(destination, JSON.stringify(inputConfig()));
    await fs.symlink(destination, path.join(root, 'config.json'));
    assert.equal((await runDockerSetup({ root, io: fakeIO([]), owner, telegramInfo: info })).status, 'failed');
    assert.equal((await fs.lstat(path.join(root, 'config.json'))).isSymbolicLink(), true);
  }
});
test('save failure rolls back previous replacements and preserves a private backup', async t => {
  const root = await fixture(t), before = await fs.readFile(path.join(root, 'config.json'));
  const io = fakeIO(['', '', '999:WIZARD_CANARY_NEW', 'WIZARD_CANARY_NEW_PASSWORD', '', '', 's', '', '', 's']);
  let count = 0;
  const commit = args => commitSetup({ ...args, rename: async (from, to) => { if (++count === 2) throw new Error('CANARY_FS_ERROR'); return fs.rename(from, to); } });
  assert.equal((await runDockerSetup({ root, io, owner, telegramInfo: info, commit })).status, 'failed');
  assert.deepEqual(await fs.readFile(path.join(root, 'config.json')), before);
  assert.equal(await fs.readFile(path.join(root, 'secrets', 'telegram-token'), 'utf8'), token + '\n');
  assert.equal(await fs.readFile(path.join(root, 'secrets', 'actual-password'), 'utf8'), password + '\n');
  assert.doesNotMatch(JSON.stringify(io.transcript), /CANARY/);
  assert.deepEqual(await fs.readdir(path.join(root, '.setup-private')), ['backups']);
});
test('manual ID fallback requires explicit ownership confirmation and local model needs confirmation', async t => {
  const root = tempDirectory(t);
  const fallback = async () => ({ event: 'telegram_info_failed', code: 'NETWORK_FAILED' });
  const io = fakeIO(['', 'synthetic-budget', token, password, '', '', '321', '', 's', 's', '', 'qwen3:8b', '']);
  assert.equal((await runDockerSetup({ root, io, owner, telegramInfo: fallback })).status, 'cancelled');
  assert.equal(await fs.stat(path.join(root, 'config.json')).then(() => true, () => false), false);
});
test('custom Docker state and secret locations are preserved and require manual setup', async t => {
  for (const extra of [{ dataDir: '/data/subdir' }, { secretDir: '/run/other-secrets' }]) {
    const root = await fixture(t, { ...inputConfig(), ...extra }), before = await fs.readFile(path.join(root, 'config.json'));
    const io = fakeIO([]);
    assert.equal((await runDockerSetup({ root, io, owner, telegramInfo: info })).status, 'failed');
    assert.match(io.transcript.join(''), /REQUIRES_MANUAL_SETUP/);
    assert.deepEqual(await fs.readFile(path.join(root, 'config.json')), before);
  }
});
test('Telegram credential/webhook failures abort safely and placeholder owner is never a default', async t => {
  for (const code of ['TELEGRAM_REJECTED', 'TELEGRAM_WEBHOOK_ACTIVE']) {
    const root = tempDirectory(t), io = fakeIO(freshAnswers());
    const result = await runDockerSetup({ root, io, owner, telegramInfo: async () => ({ event: 'telegram_info_failed', code }) });
    assert.equal(result.status, 'failed'); assert.match(io.transcript.join(''), new RegExp(code));
    assert.equal(await fs.stat(path.join(root, 'config.json')).then(() => true, () => false), false);
  }
  const config = inputConfig(); config.telegram.userId = config.telegram.chatId = 123456789;
  const root = await fixture(t, config), io = fakeIO(['', '', '', '', '', '']);
  assert.equal((await runDockerSetup({ root, io, owner, telegramInfo: async () => ({ event: 'telegram_info_ok', candidates: [] }) })).status, 'cancelled');
  assert.match(io.transcript.join(''), /Seu userId Telegram \(número\):/); assert.doesNotMatch(io.transcript.join(''), /\[123456789\]/);
});
test('malformed existing secret can be replaced explicitly with the old bytes backed up', async t => {
  const root = await fixture(t), malformed = 'WIZARD_CANARY_BAD\nSECOND_LINE';
  await fs.writeFile(path.join(root, 'secrets', 'telegram-token'), malformed);
  const io = fakeIO(['', '', token, '', '', '', 's', '', '', 's']);
  assert.equal((await runDockerSetup({ root, io, owner, telegramInfo: info })).status, 'saved');
  const backups = await fs.readdir(path.join(root, '.setup-private', 'backups'));
  assert.equal(await fs.readFile(path.join(root, '.setup-private', 'backups', backups[0], 'secret-telegram-token'), 'utf8'), malformed);
  assert.doesNotMatch(io.transcript.join(''), /CANARY/);
});
test('Bash entrypoint rejects noninteractive input before any Docker operation', () => {
  if (process.platform === 'win32') return;
  const result = spawnSync('bash', ['scripts/setup-docker.sh'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.match(result.stdout, /terminal interativo/); assert.equal(result.stderr, '');
});
