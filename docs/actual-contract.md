# Contrato do adaptador Actual

O adaptador usa `@actual-app/api` fixado em **26.9.0** (`package.json`). O dispatcher do worker aceita somente `snapshot`, `inspectTransaction`, `changeCategory` e `close` (`src/actual/worker.mjs`). A fila de `ActualClient` aguarda a terminação do worker vencido antes de permitir outro dono do mesmo cache; stdout/stderr do SDK não são encaminhados.

## Proteção contra execução automática de agendas

O SDK 26.9.0 registra um listener de sincronização que pode lançar transações e avançar agendas já configuradas, inclusive quando a aplicação só consulta dados. `InitConfig` não oferece opção pública para desativá-lo. O teste `test/sdk-safety.test.mjs` reproduz o efeito em orçamento descartável: uma agenda vence após avançar o relógio; o SDK original cria um lançamento ao executar init/downloadBudget/sync de uma consulta com `dryRun:true`. [Fonte fixada do serviço](https://github.com/actualbudget/actual/blob/v26.9.0/packages/loot-core/src/server/schedules/app.ts), [InitConfig fixado](https://github.com/actualbudget/actual/blob/v26.9.0/packages/loot-core/src/server/main.ts).

`src/actual/sdk-loader.mjs` usa o hook síncrono público `node:module.registerHooks` dentro do worker, antes de inicializar o SDK ou resolver segredos. Valida versão 26.9.0, a URL original do entry CommonJS e o SHA-256 dos bytes efetivamente fornecidos por `nextLoad`: `e3a03176743d49810357fd34104f2d6841178c257234526cae0f6b697d1bcd9a`. Exige uma ocorrência exata do listener automático e remove somente seu registro em memória, incluindo o `savePrefs({lastScheduleRun})` associado. O arquivo em `node_modules`, as regras, as datas e as preferências do orçamento não são editados pela proteção. Filename, assets, exportações e sincronização do SDK continuam com sua resolução original.

A proteção permanece ativa durante toda a vida do worker, tanto com `dryRun:true` quanto com escrita autorizada. Ela não expõe o serviço manual interno nem qualquer método de agenda. O SDK ainda grava seu cache local e recebe mudanças de outros clientes durante sync; consultas não são uma promessa de cache imutável. Agendas executadas por outros clientes Actual continuam fora do controle desta aplicação.

Versão, bytes ou padrão diferentes, SDK previamente importado, cache ESM que evite o hook ou ausência de aplicação comprovada da transformação abortam com `ACTUAL_FAILED`; não existe fallback para importar o SDK original. Uma atualização exige revisar a fonte e repetir a regressão sintética antes de atualizar os valores fixados. Os hooks síncronos são uma API pública ainda classificada como release candidate no Node 24; o projeto exige esse major e valida o caminho em Linux e Docker. [Documentação Node 24](https://nodejs.org/download/release/v24.18.0/docs/api/module.html).

O teste compara o controle original com o protegido, repete leitura em novo worker no dia seguinte e verifica zero lançamentos automáticos, agendas/catálogos e `lastScheduleRun` preservados, inclusive após shutdown. No mesmo orçamento com agenda vencida, categorizar e restaurar null preservam os demais campos e o backup cifrado pode ser decifrado. Casos negativos cobrem versão, bytes retornados pelo hook e caches, antes da resolução de segredos. O hash do pacote no disco permanece igual.

## Inspeção e pré-condição

`inspectTransaction(id)` sincroniza explicitamente e executa `aqlQuery(q('transactions').filter({id}).select(campos).options({splits:'all'}))`. Exige exatamente um registro com o ID solicitado. Retorna transação canônica, conta, favorecido, categorias, grupos, elegibilidade, contexto residência/orçamento, fingerprint e horário do sync.

`transactionFingerprint(context, transaction)`, em `src/actual/transaction.mjs`, calcula SHA-256 de JSON ordenado e versionado. Inclui identidade da residência/orçamento, ID, conta, data, centavos, favorecido, notas, categoria, flags/vínculos de split e transferência, cleared/reconciled, saldo inicial e agenda. IDs opcionais são null e flags são booleanas. O fingerprint não é prova de compare-and-swap do servidor.

O pedido de alteração contém somente:

```js
// Ilustrativo: os IDs e fingerprints vêm da inspeção e proposta persistida.
{
  operationId,
  targetId,
  expectedFingerprint,
  context: { householdId, budgetId },
  categoryId,
  expectedCategory: { id, name, groupId, isIncome, hidden: false }
}
```

Para restaurar ausência: `categoryId:null, expectedCategory:null`. Demais campos são rejeitados. A aplicação vincula essa entrada a usuário/chat, prazo e proposta de uso único; persiste reserva/journal e backup SQLite antes do RPC. O executor exige correspondência exata ao contexto, fingerprint e categoria exibida. Categoria renomeada, movida, removida ou ocultada invalida a aprovação.

## Ordem de uma escrita

1. Exigir `dryRun:false`; leitura normal não exige chave de backup.
2. Sincronizar, ler o registro e conferir pré-condições/elegibilidade.
3. Exportar o orçamento e persistir o [backup cifrado](backups.md). Falha impede o patch.
4. Sincronizar e repetir as pré-condições após o tempo gasto no backup.
5. Chamar exatamente uma vez `updateTransaction(id,{category})`.
6. Reler até corresponder ao fingerprint esperado. Somente o estado anterior idêntico permite aguardar a conclusão assíncrona; qualquer outra divergência encerra como incerto. O prazo usa relógio monotônico de cinco segundos por leitura de confirmação, intervalo de 25 ms e o timeout global do worker.
7. Sincronizar explicitamente e confirmar novamente a pós-condição antes de retornar `applied` com antes/depois, fingerprints, referência do backup e `verifiedAt`.

O retorno resolvido do SDK não comprova sucesso. Falhas anteriores ao patch retornam `failed_before`; qualquer possibilidade de efeito seguida de erro/deadline/divergência retorna `uncertain`. O executor fica inutilizável após falha posterior ao patch. Mesmo quando o worker responde normalmente com `uncertain`, o cliente aguarda sua terminação antes de devolver a resposta com suas evidências ou liberar a fila: o update assíncrono do SDK pode ainda estar em andamento. Timeout/crash/perda de resposta também produz `uncertain`, após a terminação. Se a terminação falha, nenhum worker substituto pode ser criado. Nenhum desses caminhos repete o patch. A aplicação mantém operações incertas para reconciliação; não presume que o estado anterior autoriza repetir uma tentativa desconhecida.

## Elegibilidade e limite do SDK

Somente transações simples são elegíveis. Pais e filhos de split (inclusive `parent_id` isolado), transferências pelo vínculo ou favorecido, saldo inicial, conta encerrada/fora do orçamento e favorecido referenciado ausente são recusados antes do SDK update. Destinos precisam existir em grupo existente/visível e ser visíveis.

O teste `test/sdk-mutations.test.mjs` reproduz um defeito da versão fixada: `updateTransaction(childId,{category})` no filho de split zera seu valor e remove seu favorecido próprio. O SDK substitui o filho pelo patch parcial antes de recriá-lo (`shared/transactions.ts`, `makeChild`; bundle instalado `dist/index.js` na região 108882–109035). O teste confirma também que nosso executor bloqueia pai e filho sem chamar update. Não usamos patch de registro completo: isso ampliaria os campos escritos e o risco de sobrescrever outros clientes.

No teste real em orçamento sintético, categorizar/restaurar null em transação simples preservou todos os demais campos retornados por `select('*')`. O SDK pode devolver a categoria antiga na primeira leitura após `await updateTransaction`; seu handler acessa `['updated']` sem aguardar `transactions-batch-update`. [Fonte fixada: api.ts](https://github.com/actualbudget/actual/blob/v26.9.0/packages/loot-core/src/server/api.ts#L582-L599).

O SDK não oferece versão esperada/CAS nessa API. Sync, fingerprint e fila local detectam conflitos observáveis, mas não impedem alteração de outro cliente entre a última leitura e o patch. `shutdown` captura a falha de seu próprio sync e não substitui o sync explícito. Undo usa outra proposta com o fingerprint posterior registrado e restaura somente categoria; não equivale ao undo global da interface Actual.

## Catálogos e correção do filtro

Em 26.9.0, `getCategories({hidden:true})` retorna **somente ocultas**. `getCategoryGroups({hidden:true})` também filtra grupos ocultos. O adaptador usa ambos sem parâmetro para incluir todos, mantendo flags de visibilidade. A opção foi corrigida após o gate 1B, antes da publicação do MVP; o teste anterior validava orçamento mensal sem verificar o catálogo independente.

`getAccounts()` inclui contas closed/offbudget e exclui tombstones; `getPayees()` inclui favorecidos de transferência para contas não removidas e exclui tombstones/referências de transferência sem conta viva. Fonte: bundle fixado `getAccounts$3`/`getPayees$2` (região 62873–62929), handlers `api/accounts-get`/`api/payees-get` e métodos sem parâmetros.

`test/sdk.test.mjs` verifica agora o caminho SDK → snapshot → análise financeira com categorias/grupos visíveis e ocultos, contas closed/offbudget, favorecido de transferência, receita, estorno de receita, reembolso e split. O cenário sintético resulta em despesas líquidas 200, receitas líquidas 1500 e movimento 1300 centavos.

## Evidência e limites dos testes

`test/actual-mutations.test.mjs` cobre conflitos e alteração durante backup, destino removido/oculto/renomeado, exclusões de elegibilidade, segredo/export inválidos, sync antes/depois, resposta atrasada, divergência, timeout e ausência de reenvio. `test/sdk-mutations.test.mjs` usa o SDK real para escrita simples/null, todos os demais campos preservados, bloqueio/reprodução do defeito de split e restauração de export cifrado.

Os testes SDK bloqueiam transportes de rede e criam orçamento descartável. Os testes de cálculo e mutação substituem init/download remotos por criação local e sync por no-op. O teste de segurança das agendas usa init/downloadBudget/sync reais com uma resposta de protocolo em memória, sem mensagens remotas, e uma identidade de sync fictícia no cache sintético. Portanto **não verificam autenticação, sincronização com servidor real nem concorrência entre clientes**. A falha de sync é exercitada nos testes com API controlada. Não foram usadas credenciais nem dados financeiros reais.
