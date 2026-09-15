# Agenda, preferências e alertas

Implementação: [preferências](../src/reports/preferences.mjs), [horário civil](../src/jobs/civil-time.mjs), [scheduler](../src/jobs/scheduler.mjs), [persistência](../src/jobs/report-store.mjs) e [migração 003](../migrations/003_reports.sql). A agenda roda no processo FinAIssistent, com a mesma identidade autorizada do Telegram. Não usa modelo, serviço externo de agendamento ou credenciais adicionais.

## Ativação e configuração

Diário e alertas têm ativação independente e padrão desligado. `/preferencias` mostra o estado persistido e a ajuda completa. `/relatorio` consulta agora sem criar inscrição, ocorrência ou transição de alerta.

| Atribuição | Valores e unidade |
| --- | --- |
| `relatorio ativar` / `desativar` | Diário, explicitamente opt-in |
| `alertas ativar` / `desativar` | Varredura a cada 15 minutos UTC, todos os dias |
| `fuso America/Sao_Paulo` | Fuso válido do runtime Intl, somente para a agenda |
| `dias seg,ter,qua,qui,sex` | Dias únicos; também `todos` ou números ISO 1–7 |
| `horario 08:00` | Horário civil HH:mm; padrão 08:00 |
| `detalhe resumido` / `detalhado` | Quantidade de itens e explicações |
| `orcamento 80 100 5` | Atenção %, crítico %, margem de saída em pontos percentuais |
| `saldo <accountId> 10000` | Limite de saldo em centavos; negativos permitidos; `desligar` remove o limite |
| `margem_saldo 1000` | Centavos acima do limite para encerrar o alerta |
| `anomalia 5000 3 3` | Piso em centavos, multiplicador da mediana, multiplicador do MAD |

Todas as linhas acima são argumentos de `/preferencias`. A configuração de um limite de saldo confere o ID exato no catálogo Actual; indisponibilidade ou ID ausente não salva a atribuição. Não se infere conta corrente ou cartão pelo nome. O catálogo pode mudar depois da configuração; a ausência de uma conta não é saldo zero nem prova de recuperação.

Os limites são validados por [thresholds.mjs](../src/reports/thresholds.mjs): porcentagens inteiras 1–1000, atenção menor que crítico; margem de orçamento menor que atenção; até 100 contas únicas; centavos inteiros seguros; multiplicador da mediana 2–20 e MAD 1–20. Os limites aplicam-se à avaliação seguinte. O envelope orçamentário é integral do Actual, conforme [regras financeiras](finance.md).

## Datas, reinício e mudanças

- O fuso financeiro vem da configuração do orçamento. A data do relatório é a data nesse fuso **do instante da ocorrência agendada**, mesmo se a data civil da agenda for outra.
- Na repetição de horário ao fim do horário de verão, usa-se apenas o primeiro instante. Um horário inexistente avança para o primeiro minuto civil válido do mesmo dia; um dia civil inteiro inexistente não gera ocorrência.
- A ativação começa no instante da atribuição: não inclui ocorrências anteriores. O tick local roda a cada 30 segundos e também antes do consumo/entrega; reserva somente a última diária devida e o último intervalo de 15 minutos devido. Execução e envio dependem da fila, do SDK e do Telegram; não há garantia de pontualidade exata.
- Reinício descarta jobs antigos ainda pendentes quando uma ocorrência mais nova já venceu. Também cancela mensagens diárias antigas ainda pendentes. Faz a mesma conferência após uma leitura lenta e antes do envio. Entregas já incertas/enviadas preservam seu histórico.
- A chave diária é residência/orçamento/rotina/data civil, sem a revisão de detalhe ou limites. Alterar esses campos não recalcula uma diária já reservada. Nova hora, dias ou fuso aplicam-se somente a instantes futuros. Desativar e reativar no mesmo dia não duplica uma data civil já reservada, ainda que tenha sido cancelada.
- Datas/slots já reservados e o maior instante reservado permanecem como tombstones. Recuar o relógio não gera novas ocorrências anteriores ao maior instante conhecido. A agenda volta a produzir ocorrências quando ultrapassa esse marco; corrigir manualmente o banco não é procedimento suportado.

## Estado, entrega e falhas

A reserva de ocorrência e o job correspondente ficam no mesmo commit SQLite. Jobs agendados são leituras repetíveis, com prioridade inferior aos comandos do usuário. A conclusão grava estado da ocorrência, transições dos alertas, todas as partes da mensagem e término do job na mesma transação. Uma falha no commit deixa a leitura recuperável; não produz mensagem genérica sem vínculo com a agenda.

Desativação e alterações relevantes de política cancelam jobs pendentes e saídas ainda não iniciadas. A autorização é conferida antes da leitura, após seu resultado ou erro e antes do envio. Mudança de `/escopo` reavalia alertas na próxima varredura e impede enviar relatórios pendentes do escopo anterior. Uma chamada `sendMessage` já em andamento não pode ser desfeita; resposta ambígua fica incerta e não é repetida automaticamente.

O relatório lê novamente o Actual. Fallback aceita apenas snapshot completo com residência, orçamento, moeda, fuso, versão de normalização, escopo e datas inicial/final exatamente iguais. O texto sinaliza dados desatualizados. Leitura incompleta não fornece totais; falha de persistência não é tratada como falha do Actual. Uma diária indisponível recebe resposta vinculada à agenda; a varredura de alertas falha silenciosamente, preservando o estado. `/status` mostra última ocorrência, estado e código de falha persistido, além das entregas incertas.

O mecanismo normal da outbox continua aplicando intervalo mínimo de 1,1 s, tentativas limitadas para 429 explícito e nenhuma repetição de entrega incerta. Cada parte da mensagem tem chave estável. Um alerta pendente ou reagendado por 429 é cancelado se uma nova leitura comprovar resolução ou mudar sua transição. O guard de envio confere a transição atual, além da política e do escopo; não altera registros enviados/incertos.

## Histerese, episódios e reavaliação

A chave do alerta inclui residência/orçamento/responsável/chat, versão da regra, tipo, alvo e competência. Orçamento usa mês; saldo usa continuidade; anomalia usa lançamento/data original. Entrada em atenção/crítico e aumento de severidade geram avisos. Repetir a mesma severidade não gera nova mensagem. Uma queda só muda estado quando cruza a margem de saída da severidade anterior. Depois de retornar ao normal, uma nova ativação abre outro episódio; cada mudança tem índice persistido próprio.

Novos alvos de anomalia vêm dos últimos 30 dias; histórico comparável e alvos ativos conhecidos são relidos dentro de 12 meses. Um ID re-datado que aparece no snapshot conserva a chave acompanhada. Ausência fora do período coberto não resolve estado antigo. Alvo presente sem base suficiente, limite sem conta, valor ausente, leitura incompleta ou cache desatualizado também não provam recuperação. Detalhes estatísticos e limites de escopo estão em [reporting.md](reporting.md).

Uma varredura emite no máximo 20 novos alertas; candidatos excedentes não avançam de estado e podem ser avisados após nova leitura. Há limites de 100 mil candidatos e 10 mil anomalias ativas relevantes por leitura; ultrapassá-los interrompe a varredura sem atualizar estado. A diária/manual pode repetir condições atuais e não altera o estado do mecanismo periódico.

## Retenção e prova disponível

Snapshots seguem `retentionDays`; mensagens enviadas são minimizadas após 24 horas pelo estado existente. Textos das entregas da agenda já encerradas (`sent`, `failed`, `uncertain`) são removidos após `retentionDays`, inclusive avisos cancelados e de entrega incerta; o estado incerto e a chave de dedupe permanecem. Mensagens ainda pendentes/em envio mantêm o conteúdo para processamento. As tabelas de agenda conservam IDs, competências, severidades, episódios, revisões, referências de snapshot e horários para dedupe, reavaliação e auditoria; não guardam totais, nomes, notas, prompts ou histórico de modelo. Essas referências ainda são metadados relacionados às finanças e permanecem até remoção controlada do estado inteiro; não há purga automática dos tombstones. Preferências e limites por conta permanecem até serem alterados/removidos. A limpeza da agenda não altera o journal de operações financeiras incertas. Backups têm [retenção operacional separada](backups.md).

[scheduler.test.mjs](../test/scheduler.test.mjs) cobre relógio controlado, DST, mês/fuso, reinício, recuo de relógio, cancelamento antes/durante leitura e depois de falha, atomicidade, cache incompatível, entrega incerta, 429 obsoleto, histerese e domínio integrado. [reports.test.mjs](../test/reports.test.mjs) e [alerts-domain.test.mjs](../test/alerts-domain.test.mjs) verificam cálculos e limites puros. Esses testes sintéticos não comprovam execução no bot, servidor ou orçamento real.
