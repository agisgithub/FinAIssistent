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

Toda consulta obtém um snapshot completo antes de somar. No Telegram, as respostas separam valores, período, fonte Actual, atualização, cobertura e escopo em blocos curtos. Datas civis aparecem como `dd/mm/aaaa`; horários usam o fuso configurado, com deslocamento UTC. Comandos copiáveis continuam usando datas ISO (`aaaa-mm-dd`). IDs de snapshot/orçamento e versões das regras permanecem nos metadados da análise. IDs necessários para agir, como conta e lançamento, continuam disponíveis em linhas próprias dos catálogos. Listas são paginadas depois do cálculo; nomes longos têm abreviação visual com reticências, sem alterar números ou seleção. Texto de favorecidos não vira instrução, e links não geram prévia no Telegram ([contrato de LinkPreviewOptions](https://core.telegram.org/bots/api#linkpreviewoptions)).

Consultas repetidas fazem nova leitura para captar alterações retroativas. Na indisponibilidade do Actual, o último snapshot só é reutilizado se identidade, orçamento, moeda, fuso, período e preferência de contas coincidirem e a cobertura estiver completa. A resposta destaca `DADOS DESATUALIZADOS`. Sem correspondência, informa a data da última leitura sem apresentar totais.

## Gastos por categoria

“Quanto gastamos com mercado nos últimos seis meses?” produz uma consulta de **Mercado**, não uma soma de todas as despesas. O parser extrai o nome, e o código resolve esse nome no catálogo real de categorias de despesa, ignorando apenas diferenças de caixa, espaços e acentos. O modelo não escolhe IDs. Não existe associação automática por parecido: nome inexistente ou homônimo retorna opções do catálogo sem total.

Comando explícito: `/gastos com Mercado | ultimos 6 meses`. O separador `|` distingue o nome do período. Nomes com separadores podem ser escritos como uma string JSON entre aspas. Para homônimos em grupos diferentes, a resposta apresenta nome do grupo e um comando copiado como `/gastos com "Mercado :: grupo-real" | 2026-04-01 2026-09-15`; o par nome/grupo precisa existir no catálogo. O identificador de grupo é apenas uma desambiguação explícita, nunca um campo escolhido pelo modelo. Nomes repetidos no mesmo grupo exigem nomes distintos no Actual.

Somente transações da categoria resolvida entram nos cálculos desse filtro, incluindo seus estornos e filhos de splits. O snapshot salvo continua contendo todas as transações lidas; consultar uma categoria não reduz a cobertura de um cache usado depois para o total geral. O texto identifica o nome da categoria consultada e seu grupo por ID; sem grupo, mostra o ID da categoria. Os metadados conservam o ID resolvido. Na escolha entre categorias, grupos e IDs necessários para desambiguação continuam visíveis. Snapshots antigos sem nomes de grupos exibem o ID e “grupo não informado”, sem selecionar uma opção automaticamente.

## Comparação e perguntas de planejamento

`/comparar` e “Quais gastos aumentaram?” comparam o mês atual até hoje com os mesmos dias disponíveis do mês anterior. Um único snapshot cobre ambas as faixas, mas cada análise de despesas recorta exatamente seus dias. Lançamentos do fim do mês anterior fora da faixa comparável não entram na base. A resposta mostra bruto, estornos, líquido e variação por categoria, além de ambas as datas e durações.

Se o mês anterior for mais curto, a diferença de duração fica explícita e não há extrapolação nem normalização silenciosa por dia. Base anterior zero com despesa atual positiva vira “novo gasto no período comparado”, sem divisão por zero. A consulta compara despesas e não reetiqueta o saldo atual de uma conta como saldo histórico anterior. Esta comparação não determina a causa da mudança.

Perguntas sobre assumir parcela/financiamento ou montar plano de economia pedem renda líquida estável, compromissos, reserva, valor e prazo; parcela também pede entrada, juros/CET e número de parcelas. Esse caminho não consulta o orçamento nem usa IA e não afirma viabilidade. O schema local também oferece a intenção limitada `needs_info` para perguntas equivalentes reconhecidas pelo modelo. Este marco não implementa um simulador de crédito ou plano de economia com dados confirmados.

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
