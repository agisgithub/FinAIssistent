import { AppError, errorCode } from '../errors.mjs';
import { localToday, normalizeText } from '../finance/periods.mjs';
import { DEFAULT_SCOPE, validateScope } from '../finance/analyze.mjs';
import { parseQuery } from '../application/dispatch.mjs';
import { executeQuery } from '../application/queries.mjs';
import { renderQuery, renderScope, renderInterpretation } from '../reports/render.mjs';
import { OllamaIntentClient } from '../llm/ollama.mjs';
import { CategorizationActions } from '../application/actions.mjs';

export { localToday } from '../finance/periods.mjs';
const HELP = 'Consultas: /status, /contas, /resumo, /gastos hoje|mes, /comparar, /orcamento, /sem_categoria, /ralos e /escopo.\nCategorias: /categorias; /sugerir <transactionId>; /categorizar <transactionId> <categoryId>.\nOperações: /operacoes; /reconciliar <operationId>; /desfazer <operationId>. Toda alteração exige proposta e confirmação.\nPeríodo: YYYY-MM-DD YYYY-MM-DD; paginação: pagina 2.\nExemplo: /gastos com Mercado | ultimos 6 meses.\nPerguntas: quanto gastei hoje?; resumo nos últimos seis meses.';

export function createCommandHandler({ config, store, actual, now = () => new Date(), intentClient = new OllamaIntentClient(config), actionService = new CategorizationActions({ config, store, actual, now }) }) {
  return async (request, job) => {
    const startedAt = performance.now();
    const answer = (text, metadata = { provider: 'deterministic', reason: 'deterministic_parser', durationMs: Math.max(0, Math.round(performance.now() - startedAt)) }) => ({ text: `${text}\n\n${renderInterpretation(metadata)}`, metadata });
    store.assertIdentity(request.identity);
    const action = await actionService.handle(request, job);
    if (action) return action;
    if (request.type !== 'message') return answer('Este botão não está disponível.');
    const normalized = normalizeText(request.text);
    const [command, ...args] = normalized.split(' ');
    if (command === '/status') {
      const state = store.status();
      return answer(`FinAIssistent em execução.\nOrçamento vinculado. Modo: ${config.dryRun ? 'simulação' : 'operação'}.\nFila: ${state.queued}. Entregas incertas: ${state.uncertainDeliveries}. Operações incertas: ${state.uncertainOperations}. Reconciliadas por observação: ${state.observedOperations}.\nÚltima leitura: ${state.lastSnapshotAt ? new Date(state.lastSnapshotAt).toISOString() : 'ainda não realizada'}.`);
    }
    if (command === '/escopo') {
      const choices = { padrao: DEFAULT_SCOPE, encerradas: { includeOffBudget: false, includeClosed: true }, fora_orcamento: { includeOffBudget: true, includeClosed: false }, todas: { includeOffBudget: true, includeClosed: true } };
      if (args.length && (args.length !== 1 || !Object.hasOwn(choices, args[0]))) throw new AppError('INPUT_INVALID');
      const scope = args.length ? choices[args[0]] : validateScope(store.getPreference('finance_scope', DEFAULT_SCOPE));
      if (args.length) store.setPreference('finance_scope', scope);
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
