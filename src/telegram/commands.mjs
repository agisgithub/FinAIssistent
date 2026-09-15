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

export { localToday } from '../finance/periods.mjs';
const HELP = 'Consultas: /status, /contas, /resumo, /gastos hoje|mes, /comparar, /orcamento, /sem_categoria, /ralos e /escopo.\nRelatórios: /relatorio (consulta imediata); /preferencias para configurar e ativar diário ou alertas (desligados por padrão).\nRecorrências locais: /unidades; /recorrencias ajuda; /proximos_vencimentos; /ocorrencia ID; /pago ID; /reabrir ID.\nCategorias: /categorias; /sugerir <transactionId>; /categorizar <transactionId> <categoryId>.\nOperações: /operacoes; /reconciliar <operationId>; /desfazer <operationId>. Toda alteração exige proposta e confirmação.\nPeríodo: YYYY-MM-DD YYYY-MM-DD; paginação: pagina 2.\nExemplo: /gastos com Mercado | ultimos 6 meses.\nPerguntas: quanto gastei hoje?; resumo nos últimos seis meses.';

export function createCommandHandler({ config, store, actual, now = () => new Date(), intentClient = new OllamaIntentClient(config), actionService = new CategorizationActions({ config, store, actual, now }), billService = new BillService({ config, store, actual, now }), reportScheduler = new ReportScheduler({ config, store, actual, now: () => now().getTime(), upcomingProvider: options => billService.getUpcoming(options) }) }) {
  return async (request, job) => {
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
        `Pendências\nFila: ${state.queued}\nEntregas incertas: ${state.uncertainDeliveries}\nOperações incertas: ${state.uncertainOperations}${state.observedOperations ? `\nReconciliadas por observação: ${state.observedOperations}` : ''}${state.uncertainOperations ? '\nConfira /operacoes antes de repetir uma alteração.' : ''}`,
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
        const result = await intentClient.interpret(request.text, { today });
        intent = result.intent; metadata = result.metadata;
      } catch (error) {
        return answer(`Não consegui interpretar esta pergunta localmente. Código: ${errorCode(error)}.\n${HELP}\nOs comandos financeiros continuam disponíveis.`, { provider: 'ollama', model: config.ollama?.model, reason: 'local_intent', durationMs: Math.max(0, Math.round(performance.now() - startedAt)), failure: errorCode(error) });
      }
    }
    if (intent.kind === 'unsupported') return answer(`Esta pergunta não corresponde às consultas financeiras disponíveis. Reformule como uma consulta de gastos, resumo, orçamento, contas ou lançamentos sem categoria.\n${HELP}`, metadata);
    const result = await executeQuery(intent, { config, store, actual, today });
    return answer(renderQuery(result), metadata);
  };
}
