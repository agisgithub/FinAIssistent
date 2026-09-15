export const ERROR_CODES = new Set([
  'CONFIG_INVALID', 'SECRET_UNAVAILABLE', 'SECRET_PERMISSIONS', 'UNAUTHORIZED',
  'STORAGE_FAILED', 'ALREADY_RUNNING', 'ACTUAL_FAILED', 'ACTUAL_SYNC_FAILED',
  'ACTUAL_TIMEOUT', 'SNAPSHOT_INVALID', 'TELEGRAM_REJECTED', 'DELIVERY_UNCERTAIN',
  'NETWORK_FAILED', 'INPUT_INVALID', 'INTERNAL_ERROR', 'SHUTTING_DOWN', 'TELEGRAM_WEBHOOK_ACTIVE', 'TELEGRAM_RATE_LIMITED',
  'OLLAMA_DISABLED', 'OLLAMA_UNAVAILABLE', 'OLLAMA_TIMEOUT', 'OLLAMA_MODEL_UNSAFE', 'OLLAMA_INVALID_RESPONSE',
  'MUTATION_CONFLICT', 'MUTATION_INELIGIBLE', 'MUTATION_TARGET_MISSING', 'MUTATION_CATEGORY_INVALID',
  'MUTATION_DRY_RUN', 'MUTATION_UNCERTAIN', 'BACKUP_FAILED',
  'PROPOSAL_EXPIRED', 'PROPOSAL_USED', 'PROPOSAL_POLICY_CHANGED', 'OPERATION_NOT_FOUND', 'UNDO_UNAVAILABLE',
  'BILL_NOT_FOUND','BILL_CONFLICT','BILL_EVIDENCE_STALE'
]);

export class AppError extends Error {
  constructor(code, { retryAfterSeconds } = {}) {
    super(ERROR_CODES.has(code) ? code : 'INTERNAL_ERROR');
    this.name = 'AppError';
    this.code = this.message;
    if (this.code === 'TELEGRAM_RATE_LIMITED' && Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds >= 1 && retryAfterSeconds <= 3600) this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Never copy third-party error text, URLs, response bodies, SQL or cause chains.
export function errorCode(error, fallback = 'INTERNAL_ERROR') {
  return error instanceof AppError && ERROR_CODES.has(error.code) ? error.code : fallback;
}
