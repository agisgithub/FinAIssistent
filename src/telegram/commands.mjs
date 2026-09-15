import { AppError } from '../errors.mjs';

export function localToday(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = key => parts.find(p => p.type === key).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
const money = (amount, currency) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(amount / 100);

export function createCommandHandler({ config, store, actual, now = () => new Date() }) {
  return async request => {
    store.assertIdentity(request.identity);
    if (request.type !== 'message') return { text: 'Este botão não está disponível.' };
    const command = request.text.toLowerCase().split(/\s+/)[0];
    if (command === '/status') {
      const state = store.status();
      return { text: `FinAIssistent em execução.\nOrçamento vinculado. Modo: ${config.dryRun ? 'simulação' : 'operação'}.\nFila: ${state.queued}. Entregas incertas: ${state.uncertainDeliveries}. Operações incertas: ${state.uncertainOperations}.\nÚltima leitura: ${state.lastSnapshotAt ? new Date(state.lastSnapshotAt).toISOString() : 'ainda não realizada'}.` };
    }
    if (!['/contas', '/gastos'].includes(command)) return { text: 'Comandos: /status, /contas, /gastos.' };
    const today = localToday(config.timezone, now());
    const period = { start: today.slice(0, 7) + '-01', end: today };
    const snapshot = await actual.snapshot(period);
    store.saveSnapshot(snapshot);
    if (!snapshot.coverage.complete) return { text: 'Consulta incompleta: uma ou mais contas não puderam ser lidas. Nenhum total completo será apresentado. Tente novamente.' };
    if (command === '/contas') {
      return { text: `Contas do Actual — saldos até ${period.end}\n${snapshot.accounts.map(a => `${a.name}: ${money(a.balance, config.currency)}${a.offBudget ? ' (fora do orçamento)' : ''}${a.closed ? ' (encerrada)' : ''}`).join('\n') || 'Nenhuma conta.'}\nSincronizado: ${snapshot.syncedAt}` };
    }
    const accountIds = new Set(snapshot.accounts.filter(a => !a.offBudget && !a.closed).map(a => a.id));
    const transferPayees = new Set(snapshot.payees.filter(p => p.transferAccountId).map(p => p.id));
    let gross = 0;
    for (const t of snapshot.transactions) {
      if (accountIds.has(t.accountId) && !t.isParent && !t.transferId && !transferPayees.has(t.payeeId) && t.amount < 0) {
        gross -= t.amount;
        if (!Number.isSafeInteger(gross)) throw new AppError('SNAPSHOT_INVALID');
      }
    }
    return { text: `Despesas brutas de ${period.start} a ${period.end}: ${money(gross, config.currency)}.\nContas abertas dentro do orçamento; transferências e pais de splits excluídos. Estornos ainda não abatidos. Dia atual em andamento.\nFonte: Actual. Sincronizado: ${snapshot.syncedAt}` };
  };
}
