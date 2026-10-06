import { access, stat, lstat, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { configDiagnostic } from './config-diagnostics.mjs';
import { secretResolver } from './secrets/resolver.mjs';
import { errorCode } from './errors.mjs';
import { actualProfiles } from './actual/base-registry.mjs';

// Offline operator check. No SDK, database, HTTP, bot polling or financial write.
// A new, uniquely named probe is the only file written and is always removed.
async function directoryCheck(directory, { writable = false, privateBackup = false } = {}) {
  let entry;
  try { entry = await (privateBackup ? lstat(directory) : stat(directory)); }
  catch (error) { return error?.code === 'ENOENT' ? 'directory_missing' : 'directory_unavailable'; }
  if (!entry.isDirectory() || (privateBackup && entry.isSymbolicLink())) return 'expected_directory';
  if (privateBackup && process.platform !== 'win32' && (entry.mode & 0o077)) return 'directory_permissions';
  try { await access(directory, constants.R_OK | constants.X_OK); } catch { return 'directory_unavailable'; }
  if (!writable) return null;
  const filename = path.join(directory, '.finaissistent-preflight-' + randomUUID());
  let handle, created = false, failure = null;
  try {
    handle = await open(filename, 'wx', 0o600); created = true;
    await handle.writeFile('preflight'); await handle.sync();
  } catch { failure = 'directory_not_writable'; }
  finally {
    try { await handle?.close(); } catch { failure = 'directory_not_writable'; }
    if (created) { try { await unlink(filename); } catch { failure = 'probe_cleanup_failed'; } }
  }
  return failure;
}

export async function preflight(filename) {
  let config;
  try { config = await loadConfig(filename); }
  catch (error) {
    return { ok: false, checks: [{ check: 'configuration', status: 'failed', code: errorCode(error), ...(configDiagnostic(error) ?? {}) }] };
  }
  const checks = [{ check: 'configuration', status: 'ok' }];
  const checkedDirectory = async (field, directory, options) => {
    const reason = await directoryCheck(directory, options);
    checks.push({ check: 'directory', field, status: reason ? 'failed' : 'ok', ...(reason ? { reason } : {}) });
  };
  await checkedDirectory('dataDir', config.dataDir, { writable: true });
  const profiles = actualProfiles(config);
  for (const profile of profiles) {
    const suffix = profiles.length === 1 && profile.alias === 'principal' ? 'actual' : `actual.bases.${profile.alias}`;
    if (profile.config.dataDir !== config.dataDir) {
      const reason = await directoryCheck(profile.config.dataDir, { writable: true });
      checks.push({ check: 'directory', field: `${suffix}.dataDir`, status: reason && reason !== 'directory_missing' ? 'failed' : 'ok', ...(reason && reason !== 'directory_missing' ? { reason } : {}) });
    }
    const cacheReason = await directoryCheck(path.join(profile.config.dataDir, 'actual'), { writable: true });
    const cacheMayBeCreated = profile.config.dataDir !== config.dataDir && cacheReason === 'directory_missing';
    checks.push({ check: 'directory', field: suffix === 'actual' ? 'dataDir.actual' : `${suffix}.cache`, status: cacheReason && !cacheMayBeCreated ? 'failed' : 'ok', ...(cacheReason && !cacheMayBeCreated ? { reason: cacheReason } : {}) });
  }
  await checkedDirectory('secretDir', config.secretDir);
  if (config.backup.keyRef || !config.dryRun) {
    for (const profile of profiles) {
      // The runtime creates a missing private backup directory inside each
      // already confined profile data directory.
      const backupDir = path.join(profile.config.dataDir, 'backups');
      const reason = await directoryCheck(backupDir, { writable: true, privateBackup: true });
      checks.push({ check: 'directory', field: profiles.length === 1 && profile.alias === 'principal' ? 'dataDir.backups' : `actual.bases.${profile.alias}.backups`, status: reason && reason !== 'directory_missing' ? 'failed' : 'ok',
        ...(reason && reason !== 'directory_missing' ? { reason } : {}) });
    }
  }
  const resolveSecret = secretResolver(config.secretDir);
  const references = [
    ['telegram.tokenRef', config.telegram.tokenRef, value => /^\d+:[A-Za-z0-9_-]+$/.test(value)],
    ...profiles.flatMap(profile => {
      const prefix = profiles.length === 1 && profile.alias === 'principal' ? 'actual' : `actual.bases.${profile.alias}`;
      return [
      [`${prefix}.passwordRef`, profile.config.actual.passwordRef, () => true],
      ...(profile.config.actual.encryptionPasswordRef ? [[`${prefix}.encryptionPasswordRef`, profile.config.actual.encryptionPasswordRef, () => true]] : [])
    ]; }),
    ...(config.backup.keyRef ? [['backup.keyRef', config.backup.keyRef, value => /^[a-fA-F0-9]{64}$/.test(value)]] : []),
    ...(config.gemini.enabled ? [['gemini.apiKeyRef', config.gemini.apiKeyRef, value => value.length <= 16384 && !/[\s\0]/.test(value)]] : [])
  ];
  if (!config.dryRun && !config.backup.keyRef) checks.push({ check: 'secret', field: 'backup.keyRef', status: 'failed', reason: 'backup_key_required_for_writes' });
  for (const [field, reference, validate] of references) {
    try {
      const value = await resolveSecret(reference);
      checks.push({ check: 'secret', field, status: validate(value) ? 'ok' : 'failed', ...(validate(value) ? {} : { reason: 'secret_format_invalid' }) });
    } catch (error) {
      checks.push({ check: 'secret', field, status: 'failed', reason: errorCode(error) === 'SECRET_PERMISSIONS' ? 'secret_permissions' : 'secret_unavailable' });
    }
  }
  return { ok: checks.every(check => check.status === 'ok'), checks };
}
