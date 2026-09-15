# Domínio de recorrências

Os módulos `src/recurrence/detect.mjs`, `calendar.mjs` e `match.mjs` são funções puras: recebem projeções de dados e retornam hipóteses, ocorrências e evidências. Não acessam SQLite, SDK, Telegram ou modelos; não confirmam cadastros, pagamentos ou lembretes. Essas decisões pertencem à aplicação autenticada e ao seu journal local.

## Fronteiras de dados e identidade

Detecção e matching novos exigem snapshot **fresco**, completo, com período exato solicitado, no máximo 12 meses civis, sem datas futuras e sem contas com falha. Exigem residência/orçamento/fuso/moeda iguais à identidade fornecida, normalização `rulesVersion:'1'` e `transactionMetadataVersion:'1'`. Reutilizam `analyzeSnapshot`, os validadores de datas e a aritmética de centavos. O escopo mantém separadas contas encerradas/fora do orçamento; sua inclusão precisa ser explícita.

`recurrenceTransactionFingerprint(identity,row)` reutiliza o fingerprint de transação completo do adaptador. Exige os campos observados, inclusive `scheduleId`, `reconciled` e `startingBalance`, com tipos explícitos. Uma versão antiga do snapshot que omitiu esses campos continua útil para consultas antigas, mas não autoriza atribuição de unidade nem nova evidência de recorrência. Edição de data, valor, conta, favorecido, notas, categoria, flags ou vínculo de agenda muda o fingerprint.

Limites: 100.000 transações, atribuições e registros por catálogo; 1.000 templates; 12.000 ocorrências e observações anteriores; no máximo 100.000 vínculos candidatos ou componentes de evidência anterior por confronto. Valores monetários e somas precisam caber em inteiros seguros. Exceder um limite interrompe o cálculo; não trunca silenciosamente o histórico.

## Unidade e eventos

A chave de comparação é residência + orçamento + **unidade** + favorecido ID + conta ID. Rótulos externos são somente texto. A aplicação fornece `knownBills` com o catálogo global de versões confirmadas que eram ativas e já entraram em vigência, não apenas a versão mais recente ou as ocorrências da janela. Versões hoje pausadas conservam seus mapeamentos históricos. Inclui também uma versão futura ativa quando uma ocorrência não cancelada, pertencente à revisão efetiva de sua competência, já tem janela de ±7 dias que alcança a leitura observável. No chamador atual, isso significa vencimento entre o início da leitura de 12 meses menos sete dias e hoje mais sete dias. Futuro distante sem essa ocorrência fica excluído. Fonte: [BillService.knownBills](../src/application/bills.mjs). O mesmo billId pode aparecer em versões com unidades distintas:

1. Uma atribuição explícita `{householdId,budgetId,transactionId,fingerprint,unitId}` válida tem prioridade.
2. Se a atribuição existe mas o fingerprint mudou, a evidência fica pendente. O domínio não usa outro mapeamento para encobrir a mudança.
3. Sem atribuição individual, um cadastro confirmado pode mapear débitos futuros quando o par favorecido/conta tem somente uma unidade. Um `sourceScheduleId` confirmado e exato também pode separar uma unidade, desde que seja único nesse par.
4. Duas unidades ainda possíveis exigem resolução. Nome, valor, `cleared` e semelhança não escolhem unidade.

Se um par migra da unidade A para B, ambas as associações históricas ficam no conjunto após a efetivação de B. A exceção observável pode antecipar a ambiguidade: em 30/09, A vencendo 30/09 e B iniciando outubro/vencendo 01/10 disputam um lançamento de 29/09. O domínio exige atribuição explícita para resolver a unidade; não decide vigência usando o mês de lançamento como se fosse competência. A fonte continua sendo versões confirmadas e evidência observada. Isso pode exigir intervenção depois de uma troca de unidade, mas impede remapear silenciosamente o passado para a versão atual.

Pais de split não entram como despesas extras. Filhos da mesma família formam um evento somente quando todos são despesas elegíveis, têm a mesma unidade/favorecido/conta/data e sua soma corresponde ao pai. A evidência lista os filhos, com `familyId`; o total do evento soma cada filho uma vez. Famílias incompletas, mistas, de transferência ou com reversão ficam pendentes. Transferências, reversões de receita, entradas positivas e saldo inicial não criam histórico de despesa recorrente. Referências ausentes no catálogo são pendências, não zeros.

## Candidatos

`detectCandidates(snapshot,{identity,today,period,scope,unitAssignments,knownBills,minimumMonths:3})` retorna `{candidates,unresolvedEvidence,metadata}`. São necessários pelo menos três meses civis **distintos e consecutivos**, cada qual com um evento comparável. Três linhas do mesmo mês não bastam. Mais de um evento no mesmo mês do mesmo grupo é ambíguo, inclusive importações aparentemente duplicadas. IDs repetidos invalidam o snapshot. Entre sequências válidas, usa a mais longa; em empate, a mais recente.

O candidato tem ID estável `cand_` + hash de identidade/unidade/favorecido/conta, meses, IDs/fingerprints de suporte e mediana monetária sugerida (meio centavo arredondado para cima). É sempre `active:false`, com data estimada e hipótese de **padrão mensal de lançamento**, não prova de competência ou vencimento. O mês atual pode participar, marcado como parcial; novo dado reabre o cálculo e pode invalidar a hipótese. Templates já conhecidos suprimem a mesma hipótese; tombstones de rejeição e adoção pertencem à aplicação. Nenhuma hipótese ativa lembretes sozinha.

## Calendário local

`buildCalendar(bills,{identity,from,to,today,timezone})` recebe competências `YYYY-MM`, intervalo inclusivo de até 12 meses. Cada template confirmado contém unidade e IDs, `startCompetence`/`endCompetence`, `dueDay:1..31`, `monthOffset:0|1`, `dateKind`, `dateSource`, valor de referência positivo ou null, ativação e revisão. `validateRecurrenceBill(bill,identity)` projeta esses campos; políticas de lembrete/variação ficam fora do domínio.

Mês de vencimento = competência + offset. Dia = menor entre `dueDay` e o último dia do mês. Janeiro/offset1/dia31 vence em 28 ou 29 de fevereiro; a competência seguinte volta a 31 de março. O template mantém 31, e a ocorrência informa `adjusted:true` quando houve ajuste. Não há transferência automática para dia útil ou feriado. O ID `occ_` deriva de residência/orçamento/billId/competência: alterar offset/data/revisão conserva o ID.

`dateKind:'confirmed'` corresponde a `dateSource:'user_confirmed'`; `estimated` corresponde a `user_estimate`. Não se converte data histórica ou regra SDK não suportada em vencimento confirmado. O calendário gera `localState:'open'`; a aplicação sobrepõe fatos locais persistidos e preserva competências encerradas ao editar templates.

`deriveOccurrenceState(occurrence,{today,match})` retorna estado visual e campos separados. Prioridade: cancelado → pagamento manual → vencimento confirmado ultrapassado → compatível → planejado. `overdue` significa **pagamento não confirmado**, não prova de dívida. Data estimada ultrapassada conserva planejado/compatível e marca `estimatedDatePassed`. Documento permanece `unverified`. Exclusão de transação não desfaz pagamento manual.

## Confronto e variação

`matchOccurrences(occurrences,snapshot,{identity,today,period,scope,unitAssignments,knownBills,dateWindowDays:7,previousMatches,dataState:'fresh'})` retorna `{matches,unresolvedEvidence,revokedEvidence,metadata}`. A janela é inclusiva, ±7 dias por padrão, configurável de 0 a31, e aparece nos critérios de cada resultado. Não exige valor idêntico: diferença de valor é objeto de comparação posterior. Nunca retorna pagamento.

Uma ocorrência recebe `compatible` somente com um evento exclusivo e unidade/IDs/data resolvidos. Mais de um evento ou disputa pelo mesmo evento resulta em `ambiguous`. Uma ocorrência com cobertura parcial também participa da disputa por eventos visíveis, impedindo que outra os reivindique como exclusivos. Janela sem cobertura até hoje, unidade/família pendente ou snapshot desatualizado resulta em `unknown`, sem promoção. O resultado informa magnitude única em `observedAmountCents`; componentes de split não representam faturas independentes.

No snapshot fresco, fingerprint diferente revoga a evidência antiga. Ausência revoga somente quando a data da observação anterior está dentro da cobertura completa; fora dela não há prova. Reatribuição requer decisão explícita e fingerprint novo. O domínio entrega razões de revogação; a aplicação conserva histórico e deixa claro quando uma observação é antiga.

`evaluateVariation({referenceAmountCents,observedAmountCents,percent:20,minimumCents:2000})` usa magnitudes em centavos e BigInt nas comparações:

```text
abs(observado - referência) > mínimo_em_centavos
E abs(observado - referência) × 100 > referência × percentual
```

As duas desigualdades são estritas. Exatamente R$20 ou exatamente20% não dispara. Aumento/redução e delta são explícitos. Referência ausente/zero ou observado ausente resulta em informação insuficiente, sem percentual inventado. Percentual aceita inteiros1..1000; mínimo aceita inteiro seguro não negativo. A referência precisa ter sido confirmada pela aplicação; a mediana sugerida de um candidato ainda não é essa confirmação.

## Verificação

`test/recurrence-domain.test.mjs` usa apenas dados sintéticos. Cobre meses consecutivos e duplicatas, unidades/contas, famílias de split, mapeamento confirmado e conflitos de unidade, cache antigo, cobertura e overflow, datas/offset/bissexto, distinção de estados, competição entre ocorrências, edição/exclusão/retrodatação, fingerprint completo e limites estritos de variação. Os testes não comprovam pagamentos nem conexão a serviços de produção.
