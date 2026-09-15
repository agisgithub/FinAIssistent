import { createRequire, registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError } from '../errors.mjs';

// SDK 26.9.0 starts this listener even in API mode: merely syncing can post a
// scheduled transaction or advance schedules/preferences. There is no public
// readonly option. Match the shipped bytes AND the one precise registration;
// dependency upgrades must be reviewed instead of silently losing this guard.
const VERSION = '26.9.0';
const SOURCE_SHA256 = 'e3a03176743d49810357fd34104f2d6841178c257234526cae0f6b697d1bcd9a';
const AUTOMATIC_SYNC_LISTENER = [
  'app$17.events.on("sync", ({ type }) => {',
  '\tif ((type === "success" || type === "error" || type === "unauthorized") && getPrefs()) {',
  '\t\tif (!getDatabase()) {',
  '\t\t\tlogger.info("database is not available, skipping schedule service");',
  '\t\t\treturn;',
  '\t\t}',
  '\t\tconst { lastScheduleRun } = getPrefs();',
  '\t\tif (lastScheduleRun !== currentDay()) {',
  '\t\t\trunMutator(() => advanceSchedulesService(type === "success"));',
  '\t\t\tif (type === "success") savePrefs({ lastScheduleRun: currentDay() });',
  '\t\t}',
  '\t}',
  '});'
].join('\n');

// Pure byte guard, exported for negative contract tests; it does not load or
// dispatch SDK methods. The expected version/hash/pattern cannot be configured.
export function patchPinnedSdk(source, version) {
  if (version !== VERSION) throw new AppError('ACTUAL_FAILED');
  let bytes;
  if (typeof source === 'string') bytes = Buffer.from(source, 'utf8');
  else if (source instanceof ArrayBuffer) bytes = Buffer.from(source);
  else if (ArrayBuffer.isView(source)) bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  else throw new AppError('ACTUAL_FAILED');
  if (createHash('sha256').update(bytes).digest('hex') !== SOURCE_SHA256) throw new AppError('ACTUAL_FAILED');
  const text = bytes.toString('utf8');
  if (text.split(AUTOMATIC_SYNC_LISTENER).length !== 2) throw new AppError('ACTUAL_FAILED');
  return text.replace(AUTOMATIC_SYNC_LISTENER, '// FinAIssistent: automatic schedule sync listener disabled in this worker.');
}

let attempted = false;

export async function loadPinnedActual() {
  if (isMainThread || attempted || Number(process.versions.node.split('.')[0]) !== 24) throw new AppError('ACTUAL_FAILED');
  attempted = true;
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@actual-app/api');
    const url = pathToFileURL(entry).href;
    const version = JSON.parse(readFileSync(path.resolve(path.dirname(entry), '../package.json'), 'utf8')).version;
    if (version !== VERSION || require.cache[entry]) throw new AppError('ACTUAL_FAILED');
    let applications = 0;
    // Synchronous public hooks preserve CommonJS filename/__dirname, addon and
    // relative asset resolution. No node_modules file is rewritten. This hook
    // remains scoped to this worker and exact entry URL until worker exit.
    registerHooks({ load(loadedUrl, context, nextLoad) {
      const result = nextLoad(loadedUrl, context);
      if (loadedUrl !== url) return result;
      if (applications !== 0 || result.format !== 'commonjs') throw new AppError('ACTUAL_FAILED');
      const source = patchPinnedSdk(result.source, version);
      applications++;
      return { ...result, source };
    } });
    const api = await import(url);
    // ESM caches can bypass load hooks even after require.cache was deleted.
    // Never accept an import without proof that these exact bytes were patched.
    if (applications !== 1) throw new AppError('ACTUAL_FAILED');
    return api;
  } catch { throw new AppError('ACTUAL_FAILED'); }
}
