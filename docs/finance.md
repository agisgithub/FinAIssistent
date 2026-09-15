# Regras financeiras e consultas

## Cálculos

Todas as quantias recebidas e somadas são inteiros seguros em centavos. Overflow interrompe a análise. A formatação usa inteiros `BigInt`, preservando o último centavo nos limites permitidos. Não existe conversão cambial; este marco aceita BRL.

Pais de splits são excluídos; seus filhos representam os valores. Transferências são identificadas por vínculo da transação ou favorecido vinculado a uma conta. Assim, a compra no cartão entra nas despesas e o pagamento entre contas fica excluído. O saldo de uma conta vem do endpoint próprio do Actual com data final, incluindo o histórico anterior ao período consultado.

| Movimento elegível | Classificação |
| --- | --- |
| Negativo em categoria de receita | Reversão de receita |
| Demais negativos | Despesa bruta |
| Positivo em categoria de despesa | Estorno identificado |
| Positivo em categoria de receita | Receita categorizada |
| Demais positivos | Entrada sem classificação suficiente |

Despesas líquidas = bruto − estornos. Receitas líquidas = receitas − reversões. Movimento líquido = receitas líquidas + entradas ambíguas − despesas líquidas. Essas classificações não confirmam a recorrência da renda nem a origem documental de um estorno.

## Escopo e origem

Por padrão, somente contas abertas dentro do orçamento entram nos cálculos. `/escopo` mostra a preferência; `padrao`, `encerradas`, `fora_orcamento` e `todas` alteram as duas inclusões explicitamente. `/contas` lista também as contas excluídas e informa seu estado. O snapshot e os metadados da análise conservam os IDs completos das contas incluídas.

Toda consulta obtém um snapshot completo antes de somar. As respostas mostram ID de snapshot, orçamento, período inclusivo, fuso, moeda, sincronização, cobertura, escopo e versão das regras. Listas são paginadas depois do cálculo; nomes longos têm abreviação visual com reticências, sem alterar números ou seleção. Texto de favorecidos não vira instrução, e links não geram prévia no Telegram ([contrato de LinkPreviewOptions](https://core.telegram.org/bots/api#linkpreviewoptions)).

Consultas repetidas fazem nova leitura para captar alterações retroativas. Na indisponibilidade do Actual, o último snapshot só é reutilizado se identidade, orçamento, moeda, fuso, período e preferência de contas coincidirem e a cobertura estiver completa. A resposta destaca `DADOS DESATUALIZADOS`. Sem correspondência, informa a data da última leitura sem apresentar totais.

## Datas e orçamento

`hoje`, `ontem`, `mes`, `mes passado`, intervalos ISO e até 24 meses são suportados. “Últimos seis meses” começa no primeiro dia do mês de cinco meses atrás e termina hoje. A data de hoje usa o fuso da residência; o dia em andamento fica explícito.

O envelope mensal do Actual permanece independente do filtro de contas das consultas. Seu `spent` é assinado: despesa líquida exibida = `−spent`; disponibilidade antes do consumo = `balance − spent`, quando ambos existem. A diferença entre essa disponibilidade e `budgeted` é calculada e rotulada como tal; não é um campo monetário de carryover. Limite ausente, zero ou negativo não gera divisão nem percentual artificial. Esses contratos são fixados pelo SDK e exercitados no teste sintético ([Actual v26.9.0](https://github.com/actualbudget/actual/blob/v26.9.0/packages/api/methods.ts)).

## Contratos de extensão

- `parseQuery(text,{today})`: intenção determinística de leitura ou `null` para pergunta não reconhecida.
- `executeQuery(intent,{config,store,actual,today})`: snapshot completo, análise e página; aceita apenas as intenções fechadas do schema local.
- `analyzeSnapshot(snapshot,{period,scope,today})`: totais, categorias, itens sem categoria, orçamento e metadados.
- `renderQuery(result)`: texto financeiro produzido em código; nunca aceita valores sugeridos por um modelo.
- `createCommandHandler({config,store,actual,now,intentClient})`: comandos e interpretação opcional; retorna texto e metadados de provedor/motivo/duração/uso, sem prompt bruto em logs.

As provas estão em `test/finance.test.mjs`, `test/periods.test.mjs`, `test/queries.test.mjs` e `test/fixtures/financial.mjs`.
