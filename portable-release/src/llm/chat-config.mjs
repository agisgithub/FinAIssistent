import { badConfig } from '../config-diagnostics.mjs';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const validGeminiModel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) && !value.includes('..');
const secretRef = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
function shape(input, defaults, prefix) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) badConfig(prefix, 'expected_object');
  if (Object.keys(input).some(k => !Object.hasOwn(defaults, k))) badConfig(prefix, 'unknown_field');
  return { ...defaults, ...input };
}
function integer(value, key, min, max, prefix) {
  if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) badConfig(prefix + '.' + key, 'integer_out_of_range');
}
export function validateAssistantConfig(input = {}) {
  const c = shape(input, { enabled: true, defaultProvider: 'ollama', historyTtlMinutes: 1440, maxTurns: 12, maxToolRounds: 4, maxToolCalls: 8, maxContextChars: 24000, maxToolResultChars: 8000, maxRequestBytes: 131072, outputTokens: 1024 }, 'assistant');
  if (typeof c.enabled !== 'boolean') badConfig('assistant.enabled', 'expected_boolean');
  // Explicit cloud selection belongs to an authenticated, confirmed chat session.
  if (c.defaultProvider !== 'ollama') badConfig('assistant.defaultProvider', 'local_default_required');
  for (const [key, min, max] of [['historyTtlMinutes',1,1440],['maxTurns',1,24],['maxToolRounds',1,8],['maxToolCalls',1,16],['maxContextChars',1024,100000],['maxToolResultChars',256,16000],['maxRequestBytes',4096,1048576],['outputTokens',64,4096]]) integer(c,key,min,max,'assistant');
  return Object.freeze(c);
}
export function validateGeminiConfig(input = {}) {
  const c = shape(input, { enabled: false, model: DEFAULT_GEMINI_MODEL, apiKeyRef: null, timeoutMs: 60000, maxResponseBytes: 262144, outputTokens: 4096 }, 'gemini');
  if (typeof c.enabled !== 'boolean') badConfig('gemini.enabled', 'expected_boolean');
  if (!validGeminiModel(c.model)) badConfig('gemini.model', 'invalid_identifier');
  if ((c.enabled || c.apiKeyRef !== null) && !secretRef(c.apiKeyRef)) badConfig('gemini.apiKeyRef', 'invalid_secret_reference');
  for (const [key,min,max] of [['timeoutMs',1000,120000],['maxResponseBytes',1024,1048576],['outputTokens',64,8192]]) integer(c,key,min,max,'gemini');
  return Object.freeze(c);
}
