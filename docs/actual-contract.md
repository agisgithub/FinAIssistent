# Contrato do adaptador Actual

O adaptador usa `@actual-app/api` fixado em **26.9.0** (`package.json`). O dispatcher do worker aceita somente `snapshot`, `readSchedules`, `inspectTransaction`, `inspectCategoryCatalog`, `changeCategory`, `createCategory` e `close` (`src/actual/worker.mjs`). A fila de `ActualClient` aguarda a terminação do worker vencido antes de permitir outro dono do mesmo cache; stdout/stderr do SDK não são encaminhados.

## Criação confirmada de categoria

`inspectCategoryCatalog()` retorna categorias e grupos normalizados após sync. `createCategory({operationId,name,groupId,expectedGroup,context})` permite criar somente uma categoria visível em grupo existente/visível; `expectedGroup` contém `id,name,isIncome,hidden:false`. O nome tem até 120 caracteres, sem controles/bidi. Duplicidade equivalente no mesmo grupo bloqueia antes do SDK. Não cria grupo, regra, lançamento ou pagamento.

A execução exige `dryRun:false`, contexto correto, backup cifrado e revalidação do grupo/nome depois de sync. O SDK gera o ID; retorno `applied` exige categoria única com nome/grupo/tipo/visibilidade exatos, fingerprint, releitura e sync. Qualquer possibilidade de efeito sem prova suficiente retorna `uncertain` e aposenta o worker; a API não fornece idempotency key para repetir criação com segurança. `test/actual-category-create.test.mjs` cobre falhas e precondições; `test/sdk-category-create.test.mjs` usa o SDK fixado em orçamento sintético. As limitações de rede/concorrência dos testes continuam valendo.

## Proteção contra execução automática de agendas

O SDK 26.9.0 registra um listener de sincronização que pode lançar transações e avançar agendas já configuradas, inclusive quando a aplicação só consulta dados. `InitConfig` não oferece opção pública para desativá-lo. O teste `test/sdk-safety.test.mjs` reproduz o efeito em orçamento descartável: uma agenda vence após avançar o relógio; o SDK original cria um lançamento ao executar init/downloadBudget/sync de uma consulta com `dryRun:true`. [Fonte fixada do serviço](https://github.com/actualbudget/actual/blob/v26.9.0/packages/loot-core/src/server/schedules/app.ts), [InitConfig fixado](https://github.com/actualbudget/actual/blob/v26.9.0/packages/loot-core/src/server/main.ts).

`src/actual/sdk-loader.mjs` usa o hook síncrono público `node:module.registerHooks` dentro do worker, antes de inicializar o SDK ou resolver segredos. Valida versão 26.9.0, a URL original do entry CommonJS e o SHA-256 dos bytes efetivamente fornecidos por `nextLoad`: `e3a03176743d49810357fd34104f2d6841178c257234526cae0f6b697d1bcd9a`. Exige uma ocorrência exata do listener automático e remove somente seu registro em memória, incluindo o `savePrefs({lastScheduleRun})` associado. O arquivo em `node_modules`, as regras, as datas e as preferências do orçamento não são editados pela proteção. Filename, assets, exportações e sincronização do SDK continuam com sua resolução original.

A proteção permanece ativa durante toda a vida do worker, tanto com `dryRun:true` quanto com escrita autorizada. Ela não expõe o serviço manual interno nem qualquer método de agenda. O SDK ainda grava seu cache local e recebe mudanças de outros clientes durante sync; consultas não são uma promessa de cache imutável. Agendas executadas por outros clientes Actual continuam fora do controle desta aplicação.

Versão, bytes ou padrão diferentes, SDK previamente importado, cache ESM que evite o hook ou ausência de aplicação comprovada da transformação abortam com `ACTUAL_FAILED`; não existe fallback para importar o SDK original. Uma atualização exige revisar a fonte e repetir a regressão sintética antes de atualizar os valores fixados. Os hooks síncronos são uma API pública ainda classificada como release candidate no Node 24; o projeto exige esse major e valida o caminho em Linux e Docker. [Documentação Node 24](https://nodejs.org/download/release/v24.18.0/docs/api/module.html).

O teste compara o controle original com o protegido, repete leitura em novo worker no dia seguinte e verifica zero lançamentos automáticos, agendas/catálogos e `lastScheduleRun` preservados, inclusive após shutdown. No mesmo orçamento com agenda vencida, categorizar e restaurar null preservam os demais campos e o backup cifrado pode ser decifrado. Casos negativos cobrem versão, bytes retornados pelo hook e caches, antes da resolução de segredos. O hash do pacote no disco permanece igual.

## Leitura de agendas e metadados de transações

`ActualClient.readSchedules()` não recebe argumentos nem expõe um método SDK arbitrário. Usa o mesmo worker protegido, fila exclusiva, init/download, sync explícito e protocolo de timeout/terminação de `snapshot`. Não exige chave de backup. O envelope retornado contém:

```js
{
  householdId, budgetId, timezone, currency, syncedAt, createdAt,
  rulesVersion: 'schedules-1', coverage: { complete: true },
  schedules: [{
    id, name, ruleId, nextDate, completed, postsTransaction, payeeId, accountId,
    amountCents, amountRange, amountOp, date, fingerprint
  }]
}
```

Nome, conta e favorecido ausentes permanecem null. `amountCents` preserva centavos assinados para `is`/`isapprox`; em `isbetween`, fica null e `amountRange` contém `{minCents,maxCents}`. O SDK ordena os extremos ao avaliar a condição; o adaptador também os ordena. O zero que o SDK atribui quando um valor foi omitido é preservado como zero registrado, sem virar estimativa. `date` mantém a data única ou os campos tipados da recorrência: frequency, start e opcionais interval, patterns, skipWeekend, endMode, endOccurrences, endDate, weekendSolveMode. Opcionais ausentes não recebem defaults no adaptador.

Semanal, anual, último dia (`day:-1`), ordinal de dia da semana, fim após N ocorrências e ajuste de fim de semana são preservados. A camada de calendário decide se consegue expandir cada forma; uma forma tipada válida não é descartada por falta de suporte local. Datas inválidas, IDs duplicados, valores não inteiros/fora do intervalo seguro, operador/forma incompatível ou estrutura desconhecida recusam o catálogo inteiro com `SNAPSHOT_INVALID`. Os limites operacionais são 10.000 agendas por leitura e 1.000 padrões por regra. Falha de sync não produz um catálogo novo.

O fingerprint SHA-256 inclui contexto, versão e todos os campos normalizados da agenda em ordem fixa; não inclui os horários de leitura. Renomear, alterar valor, vínculos, regra ou estado invalida a evidência anterior. `getSchedules()` exclui agendas removidas e inclui concluídas e vinculadas a contas encerradas. `completed` e `postsTransaction` são metadados do Actual; não há campo paid/status no contrato. O vínculo `scheduleId` de uma transação, sua reconciliação ou uma semelhança não confirma pagamento.

Snapshots novos mantêm `rulesVersion:'1'` para as consultas financeiras e acrescentam `transactionMetadataVersion:'1'`. Cada transação passa a carregar `scheduleId`, `reconciled` e `startingBalance`, com null/booleanos canônicos compatíveis com a inspeção. Cache anterior sem esse marcador continua utilizável para consultas compatíveis, mas não comprova os campos que antes eram descartados nem promove evidência nova de recorrência.

`test/sdk-schedules.test.mjs` usa sete agendas reais após remover uma oitava, incluindo nome/identidade omitidos, formas incomuns e agenda concluída em conta encerrada. A conclusão é preparada diretamente no SQLite descartável para representar estado existente; não há API pública inventada para alterar esse campo. O teste cria saldo inicial pela API real, lê uma transação reconciliada vinculada à agenda e confere `transactionFingerprint(snapshotTx) === inspectTransaction(id).fingerprint`. `test/sdk-safety.test.mjs` cobre também `readSchedules` no caminho real init/download/sync com resposta em memória e mantém a proteção contra autopost.

Fontes fixadas: [APIScheduleEntity e conversão](https://github.com/actualbudget/actual/blob/v26.9.0/packages/loot-core/src/server/api-models.ts#L226-L254), [tipos de recorrência](https://github.com/actualbudget/actual/blob/v26.9.0/packages/loot-core/src/types/models/schedule.ts), [condição de intervalo monetário](https://github.com/actualbudget/actual/blob/v26.9.0/packages/loot-core/src/server/rules/condition.ts#L326-L336).

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
