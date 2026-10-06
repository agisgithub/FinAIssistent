import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig } from '../config.mjs';
import { actualRegistryFromConfig, validActualBaseAlias } from '../actual/base-registry.mjs';

const fail = reason => { const error = new Error('ACTUAL_BASE_CONFIG_FAILED'); error.reason = reason; throw error; };

async function privateJson(filename) {
  let stat;
  try { stat = await fs.lstat(filename); } catch { fail('file_unavailable'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 32768 || process.platform !== 'win32' && (stat.mode & 0o077)) fail('unsafe_file');
  let bytes, value;
  try { bytes = await fs.readFile(filename); value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { fail('invalid_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_json');
  return { bytes, value, stat };
}

function sourceBudgetId(source) {
  const values = [source.budgetId, source.syncId, source.sync_id, source.actual?.budgetId, source.actual?.syncId, source.actual?.sync_id]
    .filter(value => typeof value === 'string' && value.length > 0);
  const distinct = [...new Set(values)];
  if (distinct.length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(distinct[0]) || distinct[0].startsWith('REPLACE_')) fail('budget_id_unavailable');
  return distinct[0];
}

export async function addActualBase({ configFile, sourceFile, alias, serverURL }) {
  if (!validActualBaseAlias(alias) || typeof serverURL !== 'string') fail('invalid_arguments');
  const target = await privateJson(path.resolve(configFile)), source = await privateJson(path.resolve(sourceFile));
  const baseDir = path.dirname(path.resolve(configFile));
  let current;
  try { current = validateConfig(target.value, baseDir); } catch { fail('target_config_invalid'); }
  const registry = actualRegistryFromConfig(current), budgetId = sourceBudgetId(source.value);
  const existing = registry.bases[alias];
  if (existing) {
    if (existing.budgetId !== budgetId || existing.serverURL !== new URL(serverURL).toString().replace(/\/$/, '')) fail('alias_conflict');
    return Object.freeze({ status: 'unchanged', alias });
  }
  const primary = registry.bases[registry.defaultBase];
  const next = structuredClone(target.value);
  next.actual = {
    defaultBase: registry.defaultBase,
    bases: {
      ...structuredClone(registry.bases),
      [alias]: {
        serverURL,
        budgetId,
        passwordRef: primary.passwordRef,
        encryptionPasswordRef: null,
        timeoutMs: primary.timeoutMs
      }
    }
  };
  try { validateConfig(next, baseDir); } catch { fail('result_config_invalid'); }
  const destination = path.resolve(configFile), temporary = path.join(baseDir, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(next, null, 2) + '\n'); await handle.sync(); await handle.close(); handle = null;
    if (process.platform !== 'win32') { await fs.chmod(temporary, target.stat.mode & 0o777); await fs.chown(temporary, target.stat.uid, target.stat.gid); }
    const unchanged = await fs.readFile(destination);
    if (!unchanged.equals(target.bytes)) fail('target_changed');
    await fs.rename(temporary, destination);
    return Object.freeze({ status: 'updated', alias });
  } catch (error) {
    if (error?.message === 'ACTUAL_BASE_CONFIG_FAILED') throw error;
    fail('atomic_write_failed');
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}
