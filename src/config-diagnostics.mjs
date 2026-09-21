import { AppError } from './errors.mjs';

// Only authored names cross the log/CLI boundary. Never copy a JSON key,
// configured value, filename, parser exception or integration error text.
const fields = new Set([
  'configFile', 'config', 'state', 'householdId', 'timezone', 'currency', 'dataDir', 'secretDir',
  'telegram', 'telegram.userId', 'telegram.chatId', 'telegram.tokenRef',
  'actual', 'actual.serverURL', 'actual.budgetId', 'actual.passwordRef', 'actual.encryptionPasswordRef', 'actual.timeoutMs',
  'privacy', 'privacy.externalProviders', 'dryRun', 'retentionDays', 'backup', 'backup.keyRef',
  'categorization', 'categorization.rules', 'categorization.rules.id', 'categorization.rules.payeeId',
  'categorization.rules.accountId', 'categorization.rules.categoryId',
  'ollama', 'ollama.enabled', 'ollama.url', 'ollama.model', 'ollama.localOnlyConfirmed', 'ollama.allowPrivateAddress',
  'ollama.timeoutMs', 'ollama.maxInputBytes', 'ollama.maxResponseBytes', 'ollama.contextTokens', 'ollama.outputTokens',
  'assistant', 'assistant.enabled', 'assistant.defaultProvider', 'assistant.historyTtlMinutes', 'assistant.maxTurns',
  'assistant.maxToolRounds', 'assistant.maxToolCalls', 'assistant.maxContextChars', 'assistant.maxToolResultChars', 'assistant.maxRequestBytes', 'assistant.outputTokens',
  'companion', 'companion.enabled', 'companion.memoryDefaultTtlDays', 'companion.maxContextMemories',
  'companion.maxContextGoals', 'companion.maxContextChars', 'companion.transactionMonitorEnabled',
  'companion.autoCategorizeHighConfidence',
  'gemini', 'gemini.enabled', 'gemini.model', 'gemini.apiKeyRef', 'gemini.timeoutMs', 'gemini.maxResponseBytes', 'gemini.outputTokens'
]);
const reasons = new Set([
  'file_missing', 'file_unreadable', 'expected_file', 'file_too_large', 'invalid_json',
  'expected_object', 'unknown_field', 'invalid_identifier', 'expected_positive_integer',
  'private_chat_must_match_user', 'invalid_secret_reference', 'replace_placeholder',
  'invalid_timezone', 'only_brl_supported', 'invalid_url', 'unsafe_url', 'integer_out_of_range',
  'expected_boolean', 'external_providers_disabled', 'invalid_path', 'directories_must_be_separate',
  'invalid_rules', 'local_confirmation_required', 'local_model_required', 'invalid_local_model', 'local_address_required',
  'state_identity_mismatch', 'bot_identity_mismatch', 'invalid_bot_identity', 'local_default_required', 'external_provider_configuration_required', 'secret_references_must_be_distinct',
  'monitor_required', 'real_write_configuration_required'
]);
const details = new WeakMap();
export function badConfig(field, reason) {
  const error = new AppError('CONFIG_INVALID');
  if (fields.has(field) && reasons.has(reason)) details.set(error, Object.freeze({ field, reason }));
  throw error;
}
export function configDiagnostic(error) { return details.get(error) ?? null; }
export function safeConfigLogFields(value = {}) {
  return fields.has(value.configField) && reasons.has(value.configReason)
    ? { configField: value.configField, configReason: value.configReason } : {};
}
