import { safeLabel, displayDate } from './render.mjs';
import { formatMoney } from '../finance/money.mjs';

// IDs remain in structured data, never in the recognition card.
export function transactionCard({ date, amount, amountCents, payee, notes, account, category }, { reference, showCategory = false } = {}) {
  const value = amountCents ?? amount;
  const name = safeLabel(typeof payee === 'object' ? payee?.name : payee, 160);
  const detail = safeLabel(notes, 240);
  const heading = name && name !== 'não informado' ? name : detail || 'Descrição não informada pelo banco';
  return [
    `${reference ? `${reference}. ` : ''}${displayDate(date)} · ${Number.isSafeInteger(value) ? formatMoney(value) : 'valor não informado'}`,
    `${name && name !== 'não informado' ? 'Favorecido' : 'Descrição'}: ${heading}`,
    detail && detail !== heading ? `Descrição: ${detail}` : '',
    `Conta: ${safeLabel(typeof account === 'object' ? account?.name : account, 100) || 'não informada'}`,
    showCategory ? `Categoria: ${safeLabel(typeof category === 'object' ? category?.name : category) || 'sem categoria'}` : ''
  ].filter(Boolean).join('\n');
}
