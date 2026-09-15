# Relatório diário e alertas determinísticos

## Dados e períodos

`dailyReportPeriod(reportDate)`, em `src/reports/daily.mjs`, pede uma única leitura de 12 meses de calendário: primeiro dia do mês de 11 meses atrás até a data financeira do relatório, inclusive. Exemplo: `2026-09-15` pede `2025-10-01` a `2026-09-15`. A agenda converte sua ocorrência para a data do fuso financeiro; mudar o fuso da agenda não muda silenciosamente o dia contábil.

`buildDailyReport(snapshot, options)` exige a identidade esperada (`householdId`, `budgetId`, `timezone`, `currency`), cobertura completa, período anual exato, BRL e normalização `rulesVersion: '1'`. Falhas não produzem totais parciais. Reutiliza `analyzeSnapshot`: centavos inteiros seguros, contas conforme escopo, pais de split/transferências excluídos, estornos de despesa e reversões de receita separados. Contas encerradas/fora do orçamento só entram se o escopo incluir. Nomes são texto citado, nunca instruções.

O mesmo snapshot fornece recortes de transações do dia e do mês até `reportDate`. Os saldos das contas pertencem ao corte original nessa data; não representam movimento do intervalo nem são reinterpretados como um saldo de outra data. `today` informa se o dia ainda está em andamento. Relatórios atrasados preservam sua data original e podem refletir alterações retroativas conhecidas no sync.

O orçamento é o envelope mensal completo do Actual, de todas as contas, podendo incluir lançamentos posteriores à data do relatório. O filtro de contas não altera esse envelope. Disponibilidade antes do consumo é `balance − spent` no sinal original do SDK; não é promessa de renda futura. O uso compara a despesa líquida com essa disponibilidade. Valor ausente não vira zero; disponibilidade zero/negativa não gera percentual. `carryover` do SDK é booleano, não uma quantia inferida. O [contrato Actual](actual-contract.md) registra a versão e a prova sintética do SDK.

## Conteúdo e apresentação

O modo `summary` usa totais/contagens, até três itens por lista e nomes abreviados, com comandos para os detalhes. O teste de tamanho inclui nomes longos, três anomalias e três vencimentos, reservando 400 caracteres para o rodapé da integração e mantendo a resposta em até 3900 caracteres. Nenhum valor monetário é abreviado e os totais usam todos os lançamentos elegíveis. O modo `detailed` exibe até dez itens e explica os cálculos; o envio usa a divisão de mensagens da outbox.

Ambos incluem saldos, receitas/despesas do dia, despesas acumuladas no mês, comparação de orçamento, categorias sinalizadas, limites de saldo, gastos incomuns, lançamentos sem categoria, vencimentos quando disponíveis e ações de revisão. O texto compacto identifica a fonte/snapshot/sync/escopo; o objeto `metadata` preserva os períodos completos, contas incluídas/excluídas, fuso, versão financeira e `reportRulesVersion: 'daily-1'`.

O domínio não consulta IA nem grava estado. Retorna `provider: 'deterministic'`, motivo, duração medida e `usage: null`. A integração acrescenta o rodapé de provedor, motivo, tempo, falha/fallback e uso ao texto antes de persistir a entrega.

## Limiares compartilhados

`src/reports/thresholds.mjs` exporta `DEFAULT_REPORT_THRESHOLDS` e `validateReportThresholds`, reutilizados pelas preferências. O schema é fechado, retorna cópia imutável e recusa floats, IDs repetidos e unidades inválidas.

| Campo | Padrão | Significado |
| --- | --- | --- |
| `budgetWarningPercent` | 80 | Entrada no aviso do envelope |
| `budgetCriticalPercent` | 100 | Entrada no nível crítico |
| `budgetResetMarginPercent` | 5 | Margem em pontos percentuais: sai de aviso abaixo de 75%; de crítico abaixo de 95% |
| `lowBalances` | `[]` | Limites explícitos `{accountId, limitCents}`; desabilitado sem cadastro |
| `lowBalanceResetMarginCents` | 1000 | Saída do aviso ao alcançar limite + R$ 10 |
| `anomalyMinimumCents` | 5000 | Piso de diferença de R$ 50 para gasto incomum |
| `anomalyMedianMultiplier` | 3 | Multiplicador da mediana |
| `anomalyMadMultiplier` | 3 | Multiplicador do desvio absoluto mediano |

Saldo baixo gera aviso apenas para a conta cujo ID foi explicitamente configurado e incluído no escopo. Limites de contas ausentes ou excluídas são contados como **sem avaliação** no texto e nos metadados; não geram candidato nem encerram um alerta anterior. O código não adivinha se uma conta é cartão ou caixa pelo nome, nem trata todo saldo negativo como falta de liquidez. Limites de saldo podem ser negativos quando isso for explicitamente configurado. A histerese evita repetir alertas quando o valor oscila perto da borda.

## Gastos incomuns

`src/finance/anomalies.mjs` usa IDs exatos de favorecido, conta e categoria para definir comparabilidade. Referências desconhecidas e ausência de favorecido não geram associação por nome. Pais de splits, transferências e reversões de receita não entram. Filhos de splits continuam sendo lançamentos de despesa no escopo financeiro.

Novos alvos são despesas dos **últimos 30 dias inclusivos**. Isso encontra importações tardias e alterações retroativas de um gasto antes ordinário. A referência usa todas as observações comparáveis disponíveis nos 12 meses lidos com data **estritamente anterior** à do alvo; exclui alvo e qualquer lançamento do mesmo dia. São necessárias pelo menos oito observações. Sem essa base, a resposta informa insuficiência e não inventa um padrão.

Para valores absolutos em centavos:

```text
mediana = mediana das despesas comparáveis anteriores
MAD = mediana de abs(valor − mediana)
limiar = max(mediana × 3, mediana + max(MAD × 3, 5000))
incomum = valor > limiar
```

Os multiplicadores e o piso são configuráveis pelos campos acima. Medianas de duas posições centrais são arredondadas para cima quando houver meio centavo. Comparações e limites intermediários usam `BigInt`; um limite acima do intervalo seguro não é convertido em quantia arredondada. Estatísticas do mesmo grupo/data são calculadas uma vez, sem amostragem silenciosa. A saída do aviso exige valor menor ou igual a 90% do limiar, regra fixa de histerese.

O relatório identifica data, favorecido, conta, valor e referência; detalhes mostram MAD, que significa **desvio absoluto mediano**. Esse é um critério estatístico explicável, não uma conclusão sobre desperdício, fraude ou capacidade de pagamento.

## Estado dos alertas e alterações retroativas

O domínio retorna candidatos; a integração decide quais transições persistir/notificar:

```js
{
  key, // JSON de [type,targetId,competence], sem nome externo
  type: 'budget' | 'low_balance' | 'anomaly',
  targetId,
  competence, // YYYY-MM para orçamento; continuous para saldo; YYYY-MM-DD para anomalia
  severity: 'none' | 'warning' | 'critical',
  reset: { warning: boolean, critical: boolean },
  text,
  observedValue // centavos quando disponível
}
```

`reset[nivel]` indica se a condição de saída daquele nível foi comprovada. O estado anterior permanece enquanto seu reset for falso; uma condição de entrada mais grave permite escalada. Candidatos normais também são retornados para liberar o estado. Apenas uma mudança relevante gera nova notificação; persistência, inscrição, agenda, dedupe e limites de envio pertencem à integração.

`trackedAlerts` recebe anomalias persistidas como `{type:'anomaly',targetId,competence}`. Elas são reavaliadas mesmo depois dos 30 dias recentes, desde que sua data ainda esteja nos 12 meses de cobertura ou que o ID esteja presente na leitura atual (inclusive quando uma data antiga foi alterada para dentro da janela). Edição de valor pode comprovar recuperação; alvo ausente ou inelegível no escopo completo pode encerrar aquele alerta sem afirmar exclusão global do lançamento. Ausência com data fora da janela, referência desconhecida ou base que ficou insuficiente **não** comprova recuperação. Alteração da data preserva a chave da ocorrência acompanhada para evitar uma segunda notificação do mesmo alvo.

`dataState: 'stale'` sempre retorna `alertCandidates: []`: nem novo alerta nem reset é inferido de cache. O relatório rotula os dados desatualizados. A integração só pode fornecer cache com a mesma identidade, período, fuso/moeda, escopo e cobertura; sem cache compatível, deve informar indisponibilidade sem total.

## Extensão de vencimentos

O domínio aceita o calendário por injeção. Sem essa fonte, informa “calendário ainda não configurado”; uma lista vazia não comprova que nenhuma conta existe. No MVP, `ReportScheduler.upcomingProvider` recebe `BillService.getUpcoming`, que consulta os cadastros locais sem leitura Actual. A forma é:

```js
upcoming: {
  available: true,
  registeredCount: 1,
  items: [{ name: 'Conta fictícia', dueDate: '2026-09-17',
    dateKind: 'confirmed', // ou estimated
    amountCents: 12345 }] // null quando o valor não foi informado
}
```

Datas confirmadas e estimadas são identificadas individualmente. Só `registeredCount: 0`, informado pela integração, autoriza dizer que nenhuma recorrência está cadastrada. A janela exibida vai da data do relatório até sete dias depois, inclusive; isso não consulta transações futuras nem confirma um pagamento. Os itens usam a versão vigente, com unidade no rótulo; ocorrências pagas/canceladas, pausadas ou fora da faixa ativa ficam fora dos próximos vencimentos. [Cadastro e estados locais](recurrences.md).

## Provas

`test/reports.test.mjs` cobre cortes dia/mês, virada de calendário, escopo, cobertura/identidade/versões, centavos, orçamento zero/ausente, limites por conta, histerese, stale, origem de vencimentos, nomes externos e tamanho do resumo. `test/alerts-domain.test.mjs` cobre referência robusta, mínimo oito, exclusão do mesmo dia, IDs diferentes, transferências/receita, importação/edição retroativa, desaparecimento dentro/fora da cobertura, referência desconhecida e extremos inteiros. Os dados são fictícios; não houve leitura financeira real.
