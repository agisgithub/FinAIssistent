import { randomUUID } from 'node:crypto';

export const TODAY = '2026-09-15';
export const PERIOD = Object.freeze({ start: '2026-09-01', end: TODAY });
export function financialSnapshot(period = PERIOD) {
  const tx = (id, amount, extra = {}) => ({ id, amount, accountId: 'checking', date: '2026-09-10', categoryId: 'food', payeeId: 'shop', notes: '', parentId: null, isParent: false, isChild: false, transferId: null, cleared: true, ...extra });
  return {
    id: randomUUID(), householdId: 'home', budgetId: 'synthetic-budget', timezone: 'America/Sao_Paulo', currency: 'BRL',
    period: { ...period }, syncedAt: '2026-09-15T12:00:00Z', createdAt: '2026-09-15T12:00:00Z', rulesVersion: '1',
    coverage: { complete: true, failedAccountIds: [] },
    accounts: [
      { id: 'checking', name: 'Conta fictícia', balance: 990000, offBudget: false, closed: false },
      { id: 'card', name: 'Cartão fictício', balance: -15000, offBudget: false, closed: false },
      { id: 'off', name: 'Conta fora fictícia', balance: 55555, offBudget: true, closed: false },
      { id: 'closed', name: 'Conta encerrada fictícia', balance: 0, offBudget: false, closed: true }
    ],
    categories: [
      { id: 'food', name: 'Alimentação fictícia', isIncome: false, hidden: false },
      { id: 'transport', name: 'Transporte fictício', isIncome: false, hidden: false },
      { id: 'income', name: 'Receitas fictícias', isIncome: true, hidden: false }
    ],
    payees: [{ id: 'shop', name: 'Loja fictícia', transferAccountId: null }, { id: 'transfer', name: 'Transferência cartão', transferAccountId: 'card' }],
    transactions: [
      tx('grocery', -10000), tx('refund', 2000),
      tx('salary', 100000, { categoryId: 'income' }), tx('income-reversal', -1000, { categoryId: 'income' }),
      tx('unknown-inflow', 5000, { categoryId: null }), tx('uncategorized', -3000, { categoryId: null }),
      tx('split-parent', -6000, { isParent: true, categoryId: null }),
      tx('split-food', -4000, { isChild: true, parentId: 'split-parent' }),
      tx('split-transport', -2000, { isChild: true, parentId: 'split-parent', categoryId: 'transport' }),
      tx('card-purchase', -15000, { accountId: 'card' }),
      tx('card-payment-out', -15000, { categoryId: null, payeeId: 'transfer', transferId: 'card-payment-in' }),
      tx('card-payment-in', 15000, { accountId: 'card', categoryId: null, payeeId: null, transferId: 'card-payment-out' }),
      tx('payee-transfer', -500, { categoryId: null, payeeId: 'transfer' }),
      tx('off-expense', -50000, { accountId: 'off' }), tx('closed-expense', -70000, { accountId: 'closed' })
    ].filter(row => row.date >= period.start && row.date <= period.end),
    budgetMonths: period.start <= '2026-09-15' && period.end >= '2026-09-01' ? [{
      month: '2026-09', totalBudgeted: 30000, totalSpent: -31000, totalBalance: 4000,
      categories: [
        { id: 'food', name: 'Alimentação fictícia', isIncome: false, budgeted: 30000, spent: -27000, balance: 8000, received: null, carryover: true },
        { id: 'transport', name: 'Transporte fictício', isIncome: false, budgeted: 0, spent: -2000, balance: -2000, received: null, carryover: false },
        { id: 'missing', name: 'Categoria incompleta', isIncome: false, budgeted: null, spent: null, balance: null, received: null, carryover: null },
        { id: 'income', name: 'Receitas fictícias', isIncome: true, budgeted: null, spent: null, balance: null, received: 99000, carryover: null }
      ]
    }] : []
  };
}
