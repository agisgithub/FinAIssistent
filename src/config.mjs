import { open } from 'node:fs/promises';
import path from 'node:path';
import { badConfig as bad } from './config-diagnostics.mjs';
import { validateOllamaConfig } from './llm/config.mjs';
import { validateAssistantConfig, validateGeminiConfig } from './llm/chat-config.mjs';
import { validateCategorizationConfig } from './categorization/recommend.mjs';
import { validateCompanionConfig } from './companion/config.mjs';

function object(value, keys, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad(field, 'expected_object');
  if (Object.keys(value).some(k => !keys.includes(k))) bad(field, 'unknown_field');
}
const ref = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
const id = value => Number.isSafeInteger(value) && value > 0;
export function validateConfig(input, baseDir = process.cwd()) {
  object(input, ['householdId', 'timezone', 'currency', 'dataDir', 'secretDir', 'telegram', 'actual', 'privacy', 'dryRun', 'retentionDays', 'ollama', 'backup', 'categorization', 'assistant', 'gemini', 'companion'], 'config');
  object(input.telegram, ['userId', 'chatId', 'tokenRef'], 'telegram');
  object(input.actual, ['serverURL', 'budgetId', 'passwordRef', 'encryptionPasswordRef', 'timeoutMs'], 'actual');
  const privacy = input.privacy ?? { externalProviders: false };
  object(privacy, ['externalProviders'], 'privacy');
  if (typeof privacy.externalProviders !== 'boolean') bad('privacy.externalProviders', 'expected_boolean');
  const gemini = validateGeminiConfig(input.gemini), assistant = validateAssistantConfig(input.assistant);
  if (privacy.externalProviders !== gemini.enabled) bad('privacy.externalProviders', 'external_provider_configuration_required');
  if (!ref(input.householdId)) bad('householdId', 'invalid_identifier');
  if (!id(input.telegram.userId)) bad('telegram.userId', 'expected_positive_integer');
  if (!id(input.telegram.chatId)) bad('telegram.chatId', 'expected_positive_integer');
  if (input.telegram.userId !== input.telegram.chatId) bad('telegram.chatId', 'private_chat_must_match_user');
  if (!ref(input.telegram.tokenRef)) bad('telegram.tokenRef', 'invalid_secret_reference');
  if (!ref(input.actual.passwordRef)) bad('actual.passwordRef', 'invalid_secret_reference');
  if (input.actual.encryptionPasswordRef != null && !ref(input.actual.encryptionPasswordRef)) bad('actual.encryptionPasswordRef', 'invalid_secret_reference');
  if (typeof input.actual.budgetId === 'string' && input.actual.budgetId.startsWith('REPLACE_')) bad('actual.budgetId', 'replace_placeholder');
  if (typeof input.actual.budgetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.actual.budgetId)) bad('actual.budgetId', 'invalid_identifier');
  const timezone = input.timezone ?? 'America/Sao_Paulo';
  if (typeof timezone !== 'string' || !timezone) bad('timezone', 'invalid_timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { bad('timezone', 'invalid_timezone'); }
  const currency = input.currency ?? 'BRL';
  if (currency !== 'BRL') bad('currency', 'only_brl_supported'); // One currency until a tested multi-currency contract exists.
  let url;
  if (typeof input.actual.serverURL !== 'string') bad('actual.serverURL', 'invalid_url');
  try { url = new URL(input.actual.serverURL); } catch { bad('actual.serverURL', 'invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) bad('actual.serverURL', 'unsafe_url');
  const timeoutMs = input.actual.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) bad('actual.timeoutMs', 'integer_out_of_range');
  const dryRun = input.dryRun ?? true;
  if (typeof dryRun !== 'boolean') bad('dryRun', 'expected_boolean');
  const backup = input.backup ?? {};
  object(backup, ['keyRef'], 'backup');
  if (backup.keyRef != null && !ref(backup.keyRef)) bad('backup.keyRef', 'invalid_secret_reference');
  if (gemini.enabled && [input.telegram.tokenRef,input.actual.passwordRef,input.actual.encryptionPasswordRef,backup.keyRef].includes(gemini.apiKeyRef)) bad('gemini.apiKeyRef', 'secret_references_must_be_distinct');
  const retentionDays = input.retentionDays ?? 90;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) bad('retentionDays', 'integer_out_of_range');
  for (const [field, value] of [['dataDir', input.dataDir ?? './data'], ['secretDir', input.secretDir ?? './secrets']]) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) bad(field, 'invalid_path');
  }
  const dataDir = path.resolve(baseDir, input.dataDir ?? './data');
  const secretDir = path.resolve(baseDir, input.secretDir ?? './secrets');
  const related = (a, b) => { const relative = path.relative(a, b); return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
  if (related(dataDir, secretDir) || related(secretDir, dataDir)) bad('secretDir', 'directories_must_be_separate');
  const companion = validateCompanionConfig(input.companion);
  if (companion.autoCategorizeHighConfidence && (dryRun || !backup.keyRef)) bad('companion.autoCategorizeHighConfidence', 'real_write_configuration_required');
  return Object.freeze({
    householdId: input.householdId, timezone, currency, dataDir, secretDir, dryRun, retentionDays,
    telegram: Object.freeze({ ...input.telegram }),
    actual: Object.freeze({ ...input.actual, serverURL: url.toString().replace(/\/$/, ''), timeoutMs }),
    privacy: Object.freeze({ externalProviders: privacy.externalProviders }),
    assistant, gemini, companion,
    backup: Object.freeze({ keyRef: backup.keyRef ?? null }),
    categorization: validateCategorizationConfig(input.categorization),
    ollama: validateOllamaConfig(input.ollama)
  });
}
export async function loadConfig(filename = process.env.CONFIG_FILE ?? './config.json') {
  let handle, text;
  try { handle = await open(filename, 'r'); }
  catch (error) { bad('configFile', error?.code === 'ENOENT' ? 'file_missing' : 'file_unreadable'); }
  try {
    let stat;
    try { stat = await handle.stat(); } catch { bad('configFile', 'file_unreadable'); }
    if (!stat.isFile()) bad('configFile', 'expected_file');
    if (stat.size > 32768) bad('configFile', 'file_too_large');
    try { text = await handle.readFile('utf8'); } catch { bad('configFile', 'file_unreadable'); }
    if (Buffer.byteLength(text) > 32768) bad('configFile', 'file_too_large');
  } finally { await handle.close().catch(() => {}); }
  let parsed;
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { bad('configFile', 'invalid_json'); }
  return validateConfig(parsed, path.dirname(path.resolve(filename)));
}
