import { ERROR_CODES } from '../errors.mjs';

const reasons = Object.freeze({
  category_command: 'comando local de categorização',
  operation_status: 'consulta ao registro da operação',
  operation_reconcile: 'releitura do estado atual no Actual',
  approval_received: 'confirmação de uso único recebida',
  operation_result: 'registro do resultado da operação',
  operation_recovery: 'recuperação do registro após reinício',
  command_error: 'falha no processamento do comando'
});

// This wrapper is used before durable enqueue as well as at the action boundary.
// Metadata is an internal marker, so untrusted text cannot suppress the footer.
export function withActionMetadata(message, { reason = 'category_command', durationMs = null, failure = null } = {}) {
  if (message.metadata?.provider === 'deterministic' && Object.hasOwn(reasons, message.metadata.reason)) return message;
  const safeReason = Object.hasOwn(reasons, reason) ? reason : 'category_command';
  const duration = Number.isSafeInteger(durationMs) && durationMs >= 0 ? durationMs : null;
  const code = failure == null ? null : ERROR_CODES.has(failure) ? failure : 'INTERNAL_ERROR';
  const metadata = { provider: 'deterministic', reason: safeReason, durationMs: duration, failure: code, usage: null };
  return { ...message, text: `${message.text}\n\nProvedor: regras locais (sem IA). Motivo: ${reasons[safeReason]}. Tempo: ${duration === null ? 'desconhecido' : `${duration} ms`}. Falha: ${code ?? 'nenhuma'}. Fallback: não necessário. Uso de IA: nenhum.`, metadata };
}
