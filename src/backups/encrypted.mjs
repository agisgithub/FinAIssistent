import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, realpath, lstat, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { AppError } from '../errors.mjs';
import { secretResolver } from '../secrets/resolver.mjs';

const MAGIC = Buffer.from('FINAIB01');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validBackupId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const fail = () => { throw new AppError('BACKUP_FAILED'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function keyFor(config, resolveSecret = secretResolver(config.secretDir)) {
  const value = await resolveSecret(config.backup?.keyRef);
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) fail();
  return Buffer.from(value, 'hex');
}
async function directory(config) {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const root = await realpath(config.dataDir);
  const dir = path.join(root, 'backups');
  await mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(dir) !== dir || (process.platform !== 'win32' && (stat.mode & 0o077))) fail();
  return dir;
}
async function syncDirectory(dir) {
  // Windows directory handles cannot be fsynced through Node; the file itself
  // is FlushFileBuffers'd before same-directory atomic rename.
  if (process.platform === 'win32') return;
  const handle = await open(dir, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function writeEncryptedBackup(bytes, { config, operationId, kind, resolveSecret }) {
  let key, handle, temporary;
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 512 * 1024 * 1024 || !validId(operationId) || !['actual', 'state'].includes(kind)) fail();
    if (!validId(config.householdId) || !validId(config.actual?.budgetId)) fail();
    key = await keyFor(config, resolveSecret);
    const dir = await directory(config), id = randomUUID(), createdAt = new Date().toISOString();
    const metadata = { version: 1, id, kind, operationId, householdId: config.householdId, budgetId: config.actual.budgetId, createdAt };
    const header = Buffer.from(JSON.stringify(metadata)), length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    const aad = Buffer.concat([MAGIC, length, header]);
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const payload = Buffer.concat([aad, iv, cipher.getAuthTag(), ciphertext]);
    temporary = path.join(dir, '.' + id + '.part');
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(payload); await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, path.join(dir, id + '.bin')); temporary = null;
    await syncDirectory(dir);
    return { id, kind, operationId, createdAt, sha256: hash(payload), bytes: payload.length };
  } catch { fail(); }
  finally {
    key?.fill(0);
    await handle?.close().catch(() => {});
    if (temporary) await unlink(temporary).catch(() => {});
  }
}

// Local recovery helper only: never included in Telegram or worker dispatch.
export async function readEncryptedBackup(reference, { config, resolveSecret }) {
  let key, handle;
  try {
    if (!reference || !validBackupId(reference.id) || !['actual', 'state'].includes(reference.kind) || !validId(reference.operationId) || !/^[a-f0-9]{64}$/.test(reference.sha256)) fail();
    const filename = path.join(await directory(config), reference.id + '.bin');
    const entry = await lstat(filename);
    if (!entry.isFile() || entry.isSymbolicLink()) fail();
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (stat.ino !== entry.ino || stat.dev !== entry.dev || stat.size !== reference.bytes || stat.size > 512 * 1024 * 1024 + 4096 || stat.size < 41 || (process.platform !== 'win32' && (stat.mode & 0o077))) fail();
    const payload = await handle.readFile();
    if (hash(payload) !== reference.sha256 || !payload.subarray(0, 8).equals(MAGIC)) fail();
    const end = 12 + payload.readUInt32BE(8);
    if (end > 4096 || end + 28 >= payload.length) fail();
    const metadata = JSON.parse(payload.subarray(12, end).toString());
    if (metadata.version !== 1 || metadata.id !== reference.id || metadata.kind !== reference.kind || metadata.operationId !== reference.operationId || metadata.householdId !== config.householdId || metadata.budgetId !== config.actual.budgetId) fail();
    key = await keyFor(config, resolveSecret);
    const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(end, end + 12));
    decipher.setAAD(payload.subarray(0, end)); decipher.setAuthTag(payload.subarray(end + 12, end + 28));
    return Buffer.concat([decipher.update(payload.subarray(end + 28)), decipher.final()]);
  } catch { fail(); }
  finally { key?.fill(0); await handle?.close().catch(() => {}); }
}

export async function backupState(store, options) {
  let bytes;
  try {
    if (store.identity.householdId !== options.config.householdId || store.identity.budgetId !== options.config.actual.budgetId) fail();
    // better-sqlite3 serialize snapshots the open DB including committed WAL
    // pages in memory: no plaintext backup file is ever created.
    bytes = store.db.serialize();
    return await writeEncryptedBackup(bytes, { ...options, kind: 'state' });
  } catch { fail(); }
  finally { bytes?.fill(0); }
}
