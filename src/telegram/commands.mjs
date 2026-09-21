import { AppError, errorCode } from '../errors.mjs';
import { localToday, normalizeText } from '../finance/periods.mjs';
import { DEFAULT_SCOPE, validateScope } from '../finance/analyze.mjs';
import { parseQuery } from '../application/dispatch.mjs';
import { executeQuery } from '../application/queries.mjs';
import { renderQuery, renderScope, renderInterpretation, displayTime } from '../reports/render.mjs';
import { OllamaIntentClient } from '../llm/ollama.mjs';
import { CategorizationActions } from '../application/actions.mjs';
import { ReportScheduler } from '../jobs/scheduler.mjs';
import { BillService } from '../application/bills.mjs';
import { ConversationService } from '../conversation/service.mjs';
import { AssistantActions } from '../application/assistant-actions.mjs';
import { CompanionService } from '../companion/service.mjs';

export { localToday } from '../finance/periods.mjs';
const HELP = 'Conversa: /ia escolhe provedor/modelo; /ia limpar apaga contexto; /gemini pergunta solicita envio remoto com consentimento.\nCompanheiro: /memorias; /esquecer ID; /metas; /meta pausar|retomar|concluir|cancelar ID. Pedidos naturais de memória ou meta geram proposta; confirme com /confirmar_companion CODIGO ou o botão.\nConsultas: /status, /contas, /resumo, /gastos hoje|mes, /comparar, /orcamento, /sem_categoria, /ralos e /escopo.\nGráficos: peça “gráfico de gastos dos últimos 6 meses para Consumo”.\nRelatórios: /relatorio (consulta imediata); /preferencias para configurar e ativar diário ou alertas (desligados por padrão).\nRecorrências locais: /unidades; /recorrencias ajuda; /proximos_vencimentos; /ocorrencia ID; /pago ID; /reabrir ID.\nCategorias: /categorias; /sugerir <transactionId>; /categorizar <transactionId> <categoryId>.\nOperações: /operacoes; /reconciliar <operationId>; /desfazer <operationId>; /lote [ID] para propostas da conversa. Toda alteração exige proposta e confirmação.\nPeríodo: YYYY-MM-DD YYYY-MM-DD; paginação: pagina 2.\nExemplo: /gastos com Mercado | ultimos 6 meses.\nPerguntas: quanto gastei hoje?; resumo nos últimos seis meses.';

export function createCommandHandler({ config, store, actual, now = () => new Date(), intentClient = null, actionService = new CategorizationActions({ config, store, actual, now }), billService = new BillService({ config, store, actual, now }), reportScheduler = new ReportScheduler({ config, store, actual, now: () => now().getTime(), upcomingProvider: options => billService.getUpcoming(options) }), chatProviders, financeTools, conversationService, companionService, assistantActions = new AssistantActions({ config, store, actual, now }) }) {
  const companion = companionService ?? conversationService?.companion ?? financeTools?.companion ?? new CompanionService({ config, store, now });
  const conversation = conversationService ?? new ConversationService({ config, store, actual, now, providers: chatProviders, financeTools, companionService: companion });
  const legacy = async (request, job) => {
    const startedAt = performance.now();
    const answer = (text, metadata = { provider: 'deterministic', reason: 'deterministic_parser', durationMs: Math.max(0, Math.round(performance.now() - startedAt)) }) => ({ text: [text, renderInterpretation(metadata)].filter(Boolean).join('\n\n'), metadata });
    store.assertIdentity(request.identity);
    const billResult = await billService.handle(request,job);
    if (billResult) return billResult;
    const rawParts = request.type === 'message' ? request.text.trim().split(/\s+/) : [];
    if (rawParts[0]?.toLowerCase() === '/preferencias') return reportScheduler.configure(rawParts.slice(1), request.identity);
    if (rawParts[0]?.toLowerCase() === '/relatorio') {
      if (rawParts.length !== 1) throw new AppError('INPUT_INVALID');
      return reportScheduler.manualReport(request.identity);
    }
    const action = await actionService.handle(request, job);
    if (action) return action;
    if (request.type !== 'message') return answer('Este botão não está disponível.');
    const normalized = normalizeText(request.text);
    const [command, ...args] = normalized.split(' ');
    if (command === '/status') {
      const state = store.status();
      const preferences = reportScheduler.preferences.get(), reports = reportScheduler.repository.status();
      const states = { pending: 'aguardando execução', completed: 'concluída', unavailable: 'indisponível', cancelled: 'cancelada' };
      const lastReport = row => row ? `${displayTime(row.scheduled_at, config.timezone)} · ${states[row.state] ?? 'pendente de verificação'}${row.data_state === 'stale' ? ' · dados desatualizados' : row.data_state === 'incomplete' ? ' · leitura incompleta' : ''}${row.error_code ? ` · código ${row.error_code}` : ''}` : 'ainda não executado';
      return answer([
        'FINAISSISTENT · EM EXECUÇÃO',
        `Modo: ${config.dryRun ? 'simulação no Actual' : 'escrita no Actual com confirmação'}.\nOrçamento vinculado.`,
        `Última leitura\n${state.lastSnapshotAt ? displayTime(state.lastSnapshotAt, config.timezone) : 'Ainda não realizada.'}`,
        `Pendências\nFila: ${state.queued}\nEntregas incertas: ${state.uncertainDeliveries}\nOperações incertas: ${state.uncertainOperations}${state.observedOperations ? `\nReconciliadas por observação: ${state.observedOperations}` : ''}${state.uncertainOperations ? '\nConfira /operacoes antes de repetir uma alteração.' : ''}${state.assistantUncertainOperations || state.assistantPartialOperations ? `\nLotes incertos: ${state.assistantUncertainOperations ?? 0}; parciais: ${state.assistantPartialOperations ?? 0}. Confira /lote antes de repetir.` : ''}`,
        `Relatório diário: ${preferences.dailyEnabled ? 'ativado' : 'desativado'}\nÚltima ocorrência agendada: ${lastReport(reports.daily)}`,
        `Alertas: ${preferences.alertsEnabled ? 'ativados' : 'desativados'}\nÚltima ocorrência agendada: ${lastReport(reports.alerts)}`,
        'Execução concluída não comprova entrega no Telegram.'
      ].join('\n\n'));
    }
    if (command === '/escopo') {
      const choices = { padrao: DEFAULT_SCOPE, encerradas: { includeOffBudget: false, includeClosed: true }, fora_orcamento: { includeOffBudget: true, includeClosed: false }, todas: { includeOffBudget: true, includeClosed: true } };
      if (args.length && (args.length !== 1 || !Object.hasOwn(choices, args[0]))) throw new AppError('INPUT_INVALID');
      const scope = args.length ? choices[args[0]] : validateScope(store.getPreference('finance_scope', DEFAULT_SCOPE));
      if (args.length) store.transaction(() => {
        const changed = JSON.stringify(scope) !== JSON.stringify(validateScope(store.getPreference('finance_scope', DEFAULT_SCOPE)));
        store.setPreference('finance_scope', scope);
        if (changed) reportScheduler.preferences.scopeChanged();
      });
      return answer(renderScope(scope));
    }
    const today = localToday(config.timezone, now());
    let intent = parseQuery(request.text, { today }), metadata;
    if (!intent) {
      if (command.startsWith('/')) return answer(HELP);
      try {
        const result = await (intentClient ?? new OllamaIntentClient(config)).interpret(request.text, { today });
        intent = result.intent; metadata = result.metadata;
      } catch (error) {
        return answer(`Não consegui interpretar esta pergunta localmente. Código: ${errorCode(error)}.\n${HELP}\nOs comandos financeiros continuam disponíveis.`, { provider: 'ollama', model: config.ollama?.model, reason: 'local_intent', durationMs: Math.max(0, Math.round(performance.now() - startedAt)), failure: errorCode(error) });
      }
    }
    if (intent.kind === 'unsupported') return answer(`Esta pergunta não corresponde às consultas financeiras disponíveis. Reformule como uma consulta de gastos, resumo, orçamento, contas ou lançamentos sem categoria.\n${HELP}`, metadata);
    const result = await executeQuery(intent, { config, store, actual, today });
    const response = answer(renderQuery(result), metadata);
    if (result.kind === 'uncategorized') response.conversationSelection = { complete: false, transactions: [] };
    if (result.kind === 'uncategorized' && result.analysis && result.listing && result.analysis.metadata.dataState === 'fresh') {
      response.conversationSelection = { complete: true, period: result.intent.period, syncedAt: result.analysis.metadata.syncedAt, total: result.listing.total,
        transactions: result.listing.items.map(row => ({ id: row.id, date: row.date, amountCents: row.amount, notes: row.notes,
          payee: result.analysis.payees.get(row.payeeId)?.name ?? '', account: result.analysis.accounts.find(account => account.id === row.accountId), category: null,
          eligibleForCategoryChange: !row.isParent && !row.isChild && !row.parentId && !row.transferId && !row.startingBalance })) };
      if (result.listing.items.length) response.text += '\n\nPode referir-se aos itens 1 a ' + result.listing.items.length + ' desta página; por exemplo, “categorize 1 e 3”. A proposta mostrará os alvos antes de confirmar.';
    }
    return response;
  };
  return async (request, job) => {
    store.assertIdentity(request.identity);
    const replay = conversation.replay(request, job);
    if (replay) return replay;
    if (companion.isProposalAction(request)) return store.transaction(() => {
      const result = companion.handle(request, job);
      if (!result) throw new AppError('INPUT_INVALID');
      const response = conversation.remember(request, job, result);
      store.completeJob(job.id, response);
      return response;
    });
    const companionResult = companion.handle(request, job);
    if (companionResult) return conversation.remember(request, job, companionResult);
    const control = await conversation.controls(request, job);
    if (control) return control;
    const batch = await assistantActions.handle(request, job);
    if (batch) return conversation.remember(request, job, batch);
    if (request.type === 'message' && !request.text.trim().startsWith('/') && conversation.canChat()) return conversation.respond(request, job);
    return conversation.remember(request, job, await legacy(request, job));
  };
}
