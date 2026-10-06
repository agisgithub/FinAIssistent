import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, stat, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { writeEncryptedBackup, readEncryptedBackup, backupState } from '../src/backups/encrypted.mjs';
import { memoryStore, tempDirectory } from './helpers.mjs';

const options = t => ({ config: { dataDir: tempDirectory(t), householdId: 'synthetic', actual: { budgetId: 'budget' }, backup: { keyRef: 'backup-key' } }, operationId: 'operation', kind: 'actual', resolveSecret: async () => '12'.repeat(32) });
test('AES-256-GCM backups have random ciphertext, restricted opaque files and authenticated context', async t => {
  const opts = options(t), bytes = Buffer.from('synthetic secret financial data');
  const first = await writeEncryptedBackup(bytes, opts), second = await writeEncryptedBackup(bytes, opts);
  assert.notEqual(first.id, second.id); assert.notEqual(first.sha256, second.sha256);
  assert.deepEqual(await readEncryptedBackup(first, opts), bytes);
  const dir = path.join(opts.config.dataDir, 'backups');
  assert.equal((await readdir(dir)).length, 2);
  const file = path.join(dir, first.id + '.bin'), payload = await readFile(file);
  assert.equal(payload.includes(bytes), false);
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal((await stat(dir)).mode & 0o777, 0o700);
  }
  await assert.rejects(readEncryptedBackup(first, { ...opts, resolveSecret: async () => '13'.repeat(32) }), { code: 'BACKUP_FAILED' });
  await assert.rejects(readEncryptedBackup(first, { ...opts, config: { ...opts.config, householdId: 'other' } }), { code: 'BACKUP_FAILED' });
  await assert.rejects(readEncryptedBackup({ ...first, operationId: 'other' }, opts), { code: 'BACKUP_FAILED' });
  payload[payload.length - 1] ^= 1; await writeFile(file, payload);
  await assert.rejects(readEncryptedBackup(first, opts), { code: 'BACKUP_FAILED' });
  const forged = { ...first, sha256: createHash('sha256').update(payload).digest('hex') };
  await assert.rejects(readEncryptedBackup(forged, opts), { code: 'BACKUP_FAILED' }, 'GCM rejects tampering even with replaced outer hash');
});

test('bad key, invalid kind and traversing reference fail without plaintext or partial files', async t => {
  const opts = options(t);
  for (const changes of [{ resolveSecret: async () => 'bad' }, { kind: 'log' }, { operationId: '../escape' }]) await assert.rejects(writeEncryptedBackup(Buffer.from('private'), { ...opts, ...changes }), { code: 'BACKUP_FAILED' });
  assert.deepEqual(await readdir(opts.config.dataDir), []);
  await assert.rejects(readEncryptedBackup({ id: '../escape' }, opts), { code: 'BACKUP_FAILED' });
});

test('SQLite state snapshot encrypts entirely in memory and restores committed records', async t => {
  const { store, config } = memoryStore(t), opts = { ...options(t), config: { ...config, dataDir: tempDirectory(t), backup: { keyRef: 'backup-key' } } };
  store.db.exec("CREATE TABLE synthetic_check (value TEXT); INSERT INTO synthetic_check VALUES ('synthetic-before')");
  const reference = await backupState(store, opts);
  store.db.exec("UPDATE synthetic_check SET value='synthetic-after'");
  const bytes = await readEncryptedBackup(reference, opts);
  const recovered = new Database(bytes);
  try { assert.equal(recovered.prepare('SELECT value FROM synthetic_check').get().value, 'synthetic-before'); }
  finally { recovered.close(); bytes.fill(0); }
  assert.equal(reference.kind, 'state');
  assert.deepEqual(await readdir(opts.config.dataDir), ['backups']);
});

test('backup directory symlinks are rejected', { skip: process.platform === 'win32' ? 'POSIX symlink fixture; CI verifies' : false }, async t => {
  const opts = options(t), outside = tempDirectory(t);
  await mkdir(opts.config.dataDir, { recursive: true });
  await symlink(outside, path.join(opts.config.dataDir, 'backups'));
  await assert.rejects(writeEncryptedBackup(Buffer.from('private'), opts), { code: 'BACKUP_FAILED' });
  assert.deepEqual(await readdir(outside), []);
});
