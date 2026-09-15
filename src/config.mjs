import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';

const bad = () => { throw new AppError('CONFIG_INVALID'); };
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) bad();
}
const ref = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
const id = value => Number.isSafeInteger(value) && value > 0;
export function validateConfig(input, baseDir = process.cwd()) {
  object(input, ['householdId', 'timezone', 'currency', 'dataDir', 'secretDir', 'telegram', 'actual', 'privacy', 'dryRun', 'retentionDays']);
  object(input.telegram, ['userId', 'chatId', 'tokenRef']);
  object(input.actual, ['serverURL', 'budgetId', 'passwordRef', 'encryptionPasswordRef', 'timeoutMs']);
  const privacy = input.privacy ?? { externalProviders: false };
  object(privacy, ['externalProviders']);
  if (privacy.externalProviders !== false) bad();
  if (!ref(input.householdId) || !id(input.telegram.userId) || !id(input.telegram.chatId)) bad();
  if (input.telegram.userId !== input.telegram.chatId || !ref(input.telegram.tokenRef)) bad();
  if (!ref(input.actual.passwordRef) || (input.actual.encryptionPasswordRef != null && !ref(input.actual.encryptionPasswordRef))) bad();
  if (typeof input.actual.budgetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.actual.budgetId) || input.actual.budgetId.startsWith('REPLACE_')) bad();
  const timezone = input.timezone ?? 'America/Sao_Paulo';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { bad(); }
  const currency = input.currency ?? 'BRL';
  if (currency !== 'BRL') bad(); // One currency until a tested multi-currency contract exists.
  let url;
  try { url = new URL(input.actual.serverURL); } catch { bad(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) bad();
  const timeoutMs = input.actual.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) bad();
  const dryRun = input.dryRun ?? true;
  if (typeof dryRun !== 'boolean') bad();
  const retentionDays = input.retentionDays ?? 90;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) bad();
  for (const value of [input.dataDir ?? './data', input.secretDir ?? './secrets']) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) bad();
  }
  const dataDir = path.resolve(baseDir, input.dataDir ?? './data');
  const secretDir = path.resolve(baseDir, input.secretDir ?? './secrets');
  const related = (a, b) => { const relative = path.relative(a, b); return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
  if (related(dataDir, secretDir) || related(secretDir, dataDir)) bad();
  return Object.freeze({
    householdId: input.householdId, timezone, currency, dataDir, secretDir, dryRun, retentionDays,
    telegram: Object.freeze({ ...input.telegram }),
    actual: Object.freeze({ ...input.actual, serverURL: url.toString().replace(/\/$/, ''), timeoutMs }),
    privacy: Object.freeze({ externalProviders: false })
  });
}
export async function loadConfig(filename = process.env.CONFIG_FILE ?? './config.json') {
  try {
    const text = await readFile(filename, 'utf8');
    if (text.length > 32768) bad();
    return validateConfig(JSON.parse(text), path.dirname(path.resolve(filename)));
  } catch { throw new AppError('CONFIG_INVALID'); }
}
