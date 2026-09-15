import { AppError } from '../errors.mjs';
import { formatMoney } from '../finance/money.mjs';
import { label } from '../reports/render.mjs';
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
  if (p.state !== 'pending') return { text: `Proposta ${p.id}: ${p.state}. Não será executada novamente.` };
  const d = p.display;
  const undoNote = p.kind === 'undo' ? `Desfazer a categoria de uma operação anterior.${d.originalUncertain ? ' O resultado original foi incerto; o estado posterior foi observado em uma nova leitura.' : ''}\n` : '';
  const reason = p.kind === 'undo' ? (d.originalUncertain ? 'restaurar a categoria anterior a partir do estado observado; autoria da alteração original não comprovada' : 'reverter a categoria da operação confirmada') : 'categoria escolhida explicitamente pelo responsável';
  const categoryDetails = `Grupos: ${label(d.beforeGroup)} → ${label(d.afterGroup)}.\nIDs de categoria: ${p.before.categoryId ?? 'sem categoria'} → ${p.after.categoryId ?? 'sem categoria'}.`;
  return {
    text: `${p.dry_run ? 'SIMULAÇÃO — confirmar não altera o Actual.' : 'Alteração proposta — exige confirmação.'}\n${undoNote}Lançamento: ${p.before.id}\nData: ${p.before.date}; valor: ${formatMoney(p.before.amount)}.\nFavorecido: ${label(d.payeeName ?? p.before.payeeId ?? 'não informado')}.\nConta: ${label(d.accountName)}.\nCategoria: ${label(d.beforeCategory)} → ${label(d.afterCategory)}.\n${categoryDetails}\nSomente o campo categoria será alterado.\nMotivo: ${reason}.\nVálida até ${new Date(p.expires_at).toISOString()} (15 minutos).\n/confirmar ${p.nonce}\n/cancelar ${p.nonce}`,
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
  return { text: `Operação ${op.id}\n${messages[op.state] ?? 'Estado indisponível.'}${op.error_code ? `\nCódigo: ${op.error_code}.` : ''}${op.target_id ? `\nLançamento: ${op.target_id}.` : ''}${op.state === 'uncertain' ? `\n/reconciliar ${op.id}` : ''}${['applied','observed_after'].includes(op.state) && op.kind === 'category' && op.before && op.after ? `\n/desfazer ${op.id}` : ''}` };
}
