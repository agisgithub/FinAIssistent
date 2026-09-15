# Recorrências e calendário local

O Actual fornece lançamentos e agendas observadas. O SQLite do FinAIssistent guarda unidades, cadastros mensais, decisões e expectativas de vencimento. Cadastro, edição, atribuição de unidade, rejeição de candidato e mudança de ocorrência exigem proposta confirmada por quem já está autorizado no Telegram. **Essas alterações locais persistem mesmo com `dryRun:true`.** Não há pagamento bancário nem escrita no SDK neste fluxo. Fonte: [proposta pública](../src/telegram/bills.mjs), texto `ALTERAÇÃO LOCAL — persiste mesmo em dryRun`.

## Começar pelo Telegram

Os exemplos abaixo são ilustrativos. Substitua os identificadores pelos IDs exatos exibidos pelo bot; nomes não substituem IDs. Valores são inteiros em centavos, sem separador decimal.

1. `/unidade cadastrar nome="Apartamento"` prepara uma unidade. Confira e confirme pelo botão ou `/recorrencia confirmar CODIGO`. `/unidades` mostra o ID criado.
2. `/contas` fornece IDs de contas do Actual. `/recorrencias favorecidos` lista favorecidos; `/recorrencias agendamentos` lista fontes de agendas. Os dois últimos exigem leitura fresca; `/contas` pode exibir cache explicitamente desatualizado. A preparação de um cadastro novo sempre confere conta/favorecido em leitura fresca.
3. Prepare um cadastro mensal com todos os campos necessários:

```text
/recorrencia cadastrar nome="Energia" unidade=ID_UNIDADE favorecido=ID_FAVORECIDO conta=ID_CONTA inicio=2026-09 dia=10 mes_offset=1 tipo_data=confirmado valor_centavos=10000
```

4. Confira unidade, conta/favorecido, competência, regra de data, valor e políticas na proposta. Confirmar grava apenas o cadastro local. Lembretes e variação começam desligados.
5. Consulte `/proximos_vencimentos` ou `/proximos_vencimentos 2026-10`. Use `/ocorrencia ID_OCORRENCIA` para inspecionar estado, fonte e evidências.

Listas de recorrências usam cinco registros por página: `/recorrencias listar 2`, `candidatos 2`, `pendencias 2`, `favorecidos 2` ou `agendamentos 2`. `/recorrencias ajuda` mostra a gramática. Campos desconhecidos, repetidos ou posicionais depois dos campos nomeados são recusados. Valores com espaços usam aspas JSON. Fonte: [parser e ajuda](../src/telegram/bills.mjs), `parseBillCommand`; [dispatch](../src/application/bills.mjs), `Math.ceil(rows.length/5)`.

## Campos de cadastro e edição

| Campo | Valor e efeito |
| --- | --- |
| `nome` | Rótulo local não vazio, até 80 caracteres |
| `unidade`, `favorecido`, `conta` | IDs exatos de catálogos locais/Actual; obrigatórios no cadastro |
| `inicio` | Competência inicial `YYYY-MM`; obrigatória, até 11 meses anteriores ao atual |
| `fim` | Competência final inclusiva ou `sem_fim`; omitido significa sem fim |
| `dia` | Inteiro 1–31; obrigatório |
| `mes_offset` | `0` para mês da competência, `1` para o mês seguinte; obrigatório |
| `tipo_data` | `confirmado` pelo responsável ou `estimado`; obrigatório |
| `valor_centavos` | Inteiro seguro positivo ou `desconhecido`; obrigatório |
| `ativa` | `sim` ou `nao`; padrão `sim` |
| `candidato` | ID de candidato fresco pendente; opcional e exclusivo de `agendamento` |
| `agendamento` | ID exato de agenda Actual observada; opcional e exclusivo de `candidato` |
| `a_partir` | Obrigatório em edição; competência atual ou futura |
| `lembretes` | `sim`/`nao`; padrão `nao` |
| `dias` | Dias antes do vencimento: 1–12 inteiros únicos entre 0 e 90; padrão `7,3,1` |
| `horario` | Horário civil `HH:mm`, padrão `08:00`, no fuso financeiro da configuração |
| `variacao` | `sim`/`nao`; padrão `nao` |
| `percentual` | Percentual inteiro 1–1000; padrão 20 |
| `minimo_centavos` | Inteiro seguro não negativo; padrão 2000 |

Fonte: [BillService](../src/application/bills.mjs), `billFields` e `policy`; [política local](../src/recurrence/preferences.mjs), `defaultBillPolicy` e `validateBillPolicy`; [validador mensal](../src/recurrence/calendar.mjs), `validateRecurrenceBill`.

Uma edição usa os campos atuais como base e mostra antes/depois, competência de aplicação e quantidade de ocorrências abertas já materializadas afetadas. Não altera a competência inicial nem troca a fonte candidato/agendamento. Exemplo ilustrativo:

```text
/recorrencia editar ID_RECORRENCIA a_partir=2026-10 dia=15 lembretes=sim dias=7,3,1 horario=08:00 variacao=sim percentual=20 minimo_centavos=2000
```

`/recorrencia pausar ID_RECORRENCIA` prepara pausa desde a competência atual. Para programar pausa futura, use `editar ... a_partir=YYYY-MM ativa=nao`. A lista distingue versão vigente e versões programadas. Ocorrências já pagas/canceladas e alterações específicas preservam seus dados e IDs. Uma edição específica aberta usa `/ocorrencia editar ID vencimento=YYYY-MM-DD tipo_data=confirmado valor_centavos=10000`; os campos são opcionais, mas mudar vencimento exige declarar o tipo da data. Fonte: [aplicação](../src/application/bills.mjs), `effectiveBill`, `materialize` e `applyProposal`.

Edição futura invalida avisos somente das competências a partir da vigência escolhida; um aviso anterior pendente continua válido. Encurtar `fim` não apaga ocorrências históricas, pagas/canceladas ou com alteração específica. As abertas fora da faixa vigente ou de um cadastro pausado deixam os próximos vencimentos e lembretes; sua consulta identifica que estão fora da agenda atual. A alteração específica preserva os dados, mas não mantém a ocorrência ativa fora dessa faixa/política. Para retomar, prepare uma nova edição `ativa=sim` e confira a vigência e os campos antes de confirmar.

## Competência, vencimento e origem

Competência é o mês ao qual o responsável vincula a conta; vencimento é uma data civil separada. Setembro com `mes_offset=1 dia=10` vence em 10 de outubro. Dia 31 em fevereiro usa o último dia, preservando 31 para março. Não há ajuste automático de feriado ou dia útil. Estimativa ultrapassada é rotulada como tal; não vira declaração de dívida. Fonte: [regras do calendário](recurrence-domain.md#calendário-local), `Mês de vencimento = competência + offset`.

**Uma agenda Actual é fonte observada, não uma regra importada.** O cadastro local continua mensal, segundo dia, deslocamento, início e fim explicitamente confirmados. Frequências semanal/anual, `endN` e ajustes de fim de semana não são copiados nem expandidos automaticamente. O catálogo mostra a próxima data/regra original como observação. Os campos mensais locais continuam obrigatórios; a proposta revalida o fingerprint da fonte antes de confirmar. Fonte: [texto público](../src/telegram/bills.mjs), `SCHEDULE_ADAPTATION`; [preparação e confirmação](../src/application/bills.mjs), `prepareBill` e `confirm`; [contrato SDK](actual-contract.md).

## Aprender do histórico e conferir lançamentos

`/recorrencias atualizar` relê os últimos 12 meses e recalcula hipóteses e compatibilidade. Sem cadastro ou atribuição, `/recorrencias pendencias` apresenta os IDs reais, datas, valores, conta/favorecido e motivo de revisão. Resolva a unidade com uma proposta ilustrativa:

```text
/recorrencia atribuir unidade=ID_UNIDADE lancamentos=ID_TX_1,ID_TX_2,ID_TX_3
```

A proposta aceita até 30 IDs únicos e mostra o contexto de cada lançamento e sua atribuição explícita anterior. A confirmação relê os alvos e confere os fingerprints. Um lançamento editado exige nova decisão; um dado antigo não é aceito silenciosamente. Depois, consulte `/recorrencias candidatos`. Três meses civis distintos e consecutivos podem formar uma hipótese, nunca um cadastro ativo. Aceitar usa o cadastro completo com `candidato=ID`; `/recorrencia rejeitar ID_CANDIDATO` também exige confirmação e conserva a rejeição quando surgem novas evidências. Fontes: [aplicação](../src/application/bills.mjs), `prepareAssignment` e `fresh.detected.candidates`; [domínio](recurrence-domain.md#candidatos), `active:false`.

Cadastros confirmados permitem identificar a unidade de futuros débitos quando o par conta/favorecido, ou o vínculo exato de agenda, aponta para uma única unidade. Versões históricas já efetivas preservam seus mapeamentos. Quando A muda para B, ambas ficam possíveis; uma atribuição individual resolve o conflito. Uma versão futura ativa também participa quando uma ocorrência não cancelada dessa revisão tem vencimento entre o início da leitura de 12 meses menos sete dias e hoje mais sete dias. Sua janela pode conter um lançamento adiantado: em 30/09, A com vencimento 30/09 e B com vencimento 01/10 disputam um lançamento de 29/09. O futuro distante continua excluído. Não se deduz competência a partir da data de lançamento. Fonte: [mapeamento](../src/application/bills.mjs), `knownBills`; [regra de unidade](recurrence-domain.md#unidade-e-eventos).

Compatibilidade exige evento exclusivo, unidade/IDs resolvidos e janela de ±7 dias do vencimento. Split elegível é uma família, não várias faturas. Mudanças/exclusões cobertas revogam evidências; cobertura insuficiente não prova ausência. A leitura precisa ser fresca, completa e ter `transactionMetadataVersion:'1'`; o cache de consultas antigas não autoriza atribuições/candidatos. Mudar `/escopo` torna a observação anterior inelegível até nova leitura correspondente. Fonte: [refresh](../src/application/bills.mjs), `dateWindowDays:7`; [confronto](recurrence-domain.md#confronto-e-variação).

Antes do confronto, a aplicação materializa todo o intervalo potencialmente concorrente, considerando as bordas de sete dias e o offset de mês seguinte. O resultado não depende de alguém ter consultado o calendário antes. Atribuições, mapeamentos e ocorrências concorrentes fazem parte do contexto da evidência: uma decisão local que mude esse contexto invalida a observação e a variação pendente imediatamente. Um novo confronto completo precisa comprová-las novamente.

## Pagamento manual e documento

| Comando | Proposta local |
| --- | --- |
| `/pago ID [data=YYYY-MM-DD]` | Confirmação manual de pagamento; data opcional, sem futuro |
| `/reabrir ID` | Reabre uma ocorrência paga/cancelada; não desfaz pagamento bancário |
| `/cancelar_ocorrencia ID` | Cancela a ocorrência local aberta; não cancela serviço ou cobrança |

Sem `data`, a data de pagamento continua ausente. O instante de confirmação é registrado separadamente. Um lançamento compatível, `cleared`, valor igual ou vínculo SDK não marca pago. Documento permanece **chegada não verificada**; este MVP não recebe e-mail, fatura ou comprovante. Fonte: [aplicação](../src/application/bills.mjs), `after.paidAt=fields.data??null`; [estado visual](../src/recurrence/calendar.mjs), `documentStatus:'unverified'`.

## Lembretes, variação e falhas

Lembretes usam o calendário confirmado local e continuam funcionando com Actual/Ollama indisponíveis. Sua ativação e políticas pertencem a cada recorrência, separadas de `/preferencias` dos relatórios. Um tick local materializa ocorrências e grava evento/mensagem atomicamente; uma leitura SDK lenta não bloqueia esse caminho. O confronto automático tem uma fila separada, a cada hora, enquanto houver ocorrência aberta com lembretes ou variação ativados. Fonte: [BillScheduler](../src/jobs/bill-scheduler.mjs), `const HOUR=3600000` e comentário `Reconciliation is independent`.

- Reinício considera somente a última etapa vencida de cada ocorrência/revisão/política, sem etapas anteriores à confirmação. Uma data confirmada tem ainda um aviso de atraso no dia seguinte; estimativas não ganham esse aviso. Alterar política inicia nova revisão e não recupera etapas anteriores à confirmação.
- Horário repetido no fim do horário de verão usa o primeiro instante; horário inexistente avança ao primeiro minuto válido do mesmo dia. Dia inteiro inexistente não gera aviso. Relógio recuado não recria etapas anteriores ao maior instante registrado.
- Pagamento, cancelamento, pausa ou mudança aplicável de data/política invalida entregas pendentes, inclusive adiadas por 429. A guarda é repetida antes do envio. Entrega enviada/incerta permanece no histórico; não há repetição automática de resultado ambíguo.

Fontes: [agenda local](../src/jobs/bill-scheduler.mjs), `slots`, `tick` e `authorizeDelivery`; [horário civil compartilhado](../src/jobs/civil-time.mjs), `resolveCivilTime`; [testes de integração](../test/bills.test.mjs), `clock rollback` e `reminder civil fold`.

Variação exige simultaneamente diferença absoluta **maior que** o mínimo em centavos **e maior que** o percentual da referência confirmada. Com R$100,00 de referência e padrões 20%/R$20,00, R$120,00 não dispara; R$125,00 pode disparar. Referência ausente não produz percentual. Depois de entrar, o mesmo sentido continua até a diferença cair a 90% de um dos limites; trocar de sentido exige cruzar novamente ambos os limites. Alteração só de notas/categoria ou repetição da mesma leitura não cria novo episódio. Um aviso ainda pendente recebe evidência atualizada atomicamente; o enviado/incerto fica imutável. Fontes: [fórmula](recurrence-domain.md#confronto-e-variação), desigualdades estritas; [agenda](../src/jobs/bill-scheduler.mjs), `continuing`, `notify` e `observedKey`.

Se uma mudança local invalidar uma variação antes do envio, nova leitura fresca pode reativar a mesma mensagem e episódio ainda não entregues, preservando um eventual prazo 429. Isso não reativa mensagens enviadas, incertas ou rejeitadas remotamente, nem cria outra mensagem para o mesmo episódio.

O alerta de variação exige leitura correspondente à revisão/escopo, posterior à ativação, não futura e com idade máxima de uma hora. Falha Actual ou evidência desconhecida não encerra episódio; uma ausência coberta e fresca pode encerrá-lo. Calendário e lembretes locais não dependem dessa evidência. Para conferir uma falha de leitura, solicite `/recorrencias atualizar`; ela não fabrica novos resultados a partir do cache. Fonte: [agenda](../src/jobs/bill-scheduler.mjs), `freshMatch`; [aplicação](../src/application/bills.mjs), `dataState:'stale'`.

## Confirmação, recuperação e retenção

Propostas duram 15 minutos, têm nonce opaco, uso único e vínculo a responsável/chat/residência/orçamento/política. `rf:`/`rx:` são callbacks próprios, separados de categorização. O commit reúne alteração local, consumo do nonce, auditoria e todas as partes da resposta final. Crash após esse commit recupera o resultado do mesmo job sem refazer o efeito; outro pedido com o nonce usado falha. As tabelas entram pela migração 004, preservando 001–003. Fontes: [BillStore](../src/recurrence/store.mjs), `confirmation_job_id===job.id` e `bill-confirmed:`; [migração](../migrations/004_bills.sql); [teste](../test/bills.test.mjs), `migration 004 upgrades`.

`retentionDays` minimiza payloads antigos de propostas encerradas/expiradas, eventos, candidatos e mensagens terminais de recorrências; remove observações antigas de matching. Mensagens enviadas também seguem a minimização geral de 24 horas. IDs, estados, tombstones de rejeição/entrega, revisões e fingerprints de atribuição permanecem para dedupe e guardas. **Unidades, versões de cadastro e ocorrências, inclusive pagas/canceladas, continuam como registros locais com dados financeiros.** Não há exclusão automática desses fatos de negócio nem purga de todos os metadados. Backups têm [retenção operacional própria](backups.md). Essa limpeza não modifica o journal de categorização. Fonte: [retenção](../src/recurrence/store.mjs), `prune(days)`.

## Prova e limites

[bills.test.mjs](../test/bills.test.mjs) cobre confirmações, falha atômica/replay, migração com dados anteriores, dados obsoletos, DST, reinício, opt-out/429, edição de versões, variação e recuo de relógio. [mvp-bills-acceptance.test.mjs](../test/mvp-bills-acceptance.test.mjs), `MVP Telegram acceptance`, percorre ingress/handler/runtime/SQLite em disco, usando IDs e códigos das mensagens públicas, Actual indisponível, lembrete local e pagamento/reabertura confirmados. Os cenários usam dados sintéticos; não comprovam entrega no bot real, pagamento, recebimento de documento ou funcionamento do servidor pessoal.
