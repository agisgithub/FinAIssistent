import { AppError } from '../errors.mjs';
import { formatMoney } from '../finance/money.mjs';
import { label, safeLabel } from '../reports/render.mjs';
import { transactionCard } from '../reports/transaction-card.mjs';
export { label } from '../reports/render.mjs';

export function parseConfirmation(request) {
  if (request.type === 'callback') {
    const match = /^(cf|cx):([A-Za-z0-9_-]{24})$/.exec(request.data);
    if (!match) throw new AppError('INPUT_INVALID');
    return { action: match[1] === 'cf' ? 'confirm' : 'cancel', nonce: match[2] };
  }
  const parts = request.text.trim().split(/\s+/), command = parts[0].toLowerCase();
  if (!['/confirmar','/cancelar'].includes(command)) return null;
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]{24}$/.test(parts[1])) throw new AppError('INPUT_INVALID');
  return { action: command === '/confirmar' ? 'confirm' : 'cancel', nonce: parts[1] };
}
export function renderProposal(p) {
  if (!p.before || !p.display) return { text: 'A proposta expirou e seus detalhes foram removidos pela retenção. Prepare uma nova proposta.' };
  if (p.state !== 'pending') return { text: `Esta proposta não está mais pendente. Não será executada novamente.` };
  const d = p.display;
  const undoNote = p.kind === 'undo' ? `Desfazer a categoria de uma operação anterior.${d.originalUncertain ? ' O resultado original foi incerto; o estado posterior foi observado em uma nova leitura.' : ''}\n` : '';
  const reason = p.kind === 'undo' ? (d.originalUncertain ? 'restaurar a categoria anterior a partir do estado observado; autoria da alteração original não comprovada' : 'reverter a categoria da operação confirmada')
    : p.reason?.source === 'monitor' ? `sugestão do monitor baseada em ${p.reason.recommendation?.source === 'rule' ? 'regra local' : p.reason.recommendation?.source === 'confirmed' ? 'confirmações anteriores' : 'histórico'}; confiança ${p.reason.recommendation?.confidence ?? 'não informada'}, escore ${Number.isFinite(p.reason.recommendation?.score) ? p.reason.recommendation.score.toFixed(2) : 'não informado'}${p.reason.memory ? '; uma memória foi mostrada apenas como contexto e não alterou o escore' : ''}`
      : 'categoria escolhida explicitamente pelo responsável';
  const card = transactionCard({ ...p.before, payee: d.payeeName, account: d.accountName });
  return {
    text: `${p.dry_run ? 'SIMULAÇÃO — confirmar não altera o Actual.' : 'Alteração proposta — exige confirmação.'}\n${undoNote}\n${card}\n\nCategoria: ${safeLabel(d.beforeCategory)} → ${safeLabel(d.afterCategory)}\nGrupos: ${safeLabel(d.beforeGroup)} → ${safeLabel(d.afterGroup)}\nSomente a categoria será alterada.\nMotivo: ${reason}.\nUse os botões abaixo. A proposta vence em 15 minutos.`,
    replyMarkup: { inline_keyboard: [[{ text: p.dry_run ? 'Confirmar simulação' : 'Confirmar alteração', callback_data: `cf:${p.nonce}` }, { text: 'Cancelar', callback_data: `cx:${p.nonce}` }]] }
  };
}
export function renderOperation(op) {
  const messages = {
    applied: 'Categoria alterada e conferida após sincronização.',
    failed_before: 'Falhou antes da alteração. Nenhum patch foi enviado por esta operação.',
    uncertain: 'Resultado incerto. Não repetirei a alteração. Use /reconciliar para consultar o estado atual.',
    observed_after: 'Estado atual igual ao resultado proposto. A execução original continua sem autoria comprovada; apenas uma nova leitura foi realizada.',
    observed_before: 'Estado atual igual ao anterior. A execução original continua incerta; nenhum patch foi repetido.',
    simulated: 'SIMULAÇÃO concluída. O Actual não foi alterado; nenhum exemplo confirmado foi criado.',
    reserved: 'Confirmação reservada; operação ainda sem resultado.',
    executing: 'Operação em andamento; não repita a confirmação.'
  };
  const origin = op.origin === 'companion_high_confidence' ? `\nOrigem: monitor automático de alta confiança${op.decision?.candidate?.source ? ` (${op.decision.candidate.source}; escore ${op.decision.candidate.score.toFixed(2)})` : ''}.` : '';
  const details=op.before?`\n\n${transactionCard({...op.before,payee:op.display?.payeeName,account:op.display?.accountName})}${op.display?.afterCategory?`\nCategoria: ${safeLabel(op.display.afterCategory)}`:''}`:'';
  return { text: `${messages[op.state] ?? 'Estado indisponível.'}${details}${origin}${op.error_code ? `\nCódigo: ${op.error_code}.` : ''}${op.state === 'uncertain' ? `\n/reconciliar ${op.id}` : ''}${['applied','observed_after'].includes(op.state) && op.kind === 'category' && op.before && op.after ? `\nPara desfazer: /desfazer ${op.id}` : ''}` };
}
