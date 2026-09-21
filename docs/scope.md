# Escopo e aceite

Projeto novo. Baseline: Node.js 24, ESM, `@actual-app/api` 26.9.0 e `better-sqlite3` 12.11.1. Um responsável, uma residência, um orçamento e BRL.

O escopo reúne as fases 1A–1D e 2 e a extensão de conversa com ferramentas. As provas abaixo são testes locais reproduzíveis, com integrações simuladas e orçamento SDK descartável. A aprovação de CI pertence ao commit publicado; esta matriz não declara que um commit ainda não publicado passou no CI.

## Mapa de requisitos

| Requisito | Prova | Marco |
| --- | --- | --- |
| Configuração e identidade inequívocas | `config.test.mjs`: inválidos falham sem refletir dados | 1A |
| Segredos fora de configuração/logs | `config.test.mjs`, `telegram.test.mjs`: referências montadas e canários | 1A |
| Mensagem privada do responsável | `telegram.test.mjs`: usuário/grupo/bot/callback inválidos recusados | 1A |
| Deduplicação e recuperação duráveis | `storage.test.mjs`: replay, crash lógico, atomicidade da outbox e restauração | 1A |
| Exclusividade do cache Actual | `storage.test.mjs` e testes Actual: lock liberável, serialização e timeout | 1A |
| Leituras rastreáveis e completas | Testes Actual e Telegram: snapshot normalizado, sync falho e cobertura incompleta | 1A |
| Inicialização executável | `main.test.mjs`: polling, fila e entrega simulados com encerramento | 1A |
| Cálculos em centavos, splits/cartão/estornos/reversões e escopo | `finance.test.mjs`: fixture reconciliável e extremos inteiros | 1B |
| Períodos locais inclusivos e consulta de seis meses | `periods.test.mjs`, `queries.test.mjs`: limites/fuso e parser sem IA | 1B |
| Orçamento zero/ausente e carryover | `finance.test.mjs`, `queries.test.mjs`: fatos mensais e derivação de saldo separada | 1B |
| Intenções locais somente leitura | `ollama.test.mjs`, `queries.test.mjs`: schema fechado, IDs extras recusados e indisponibilidade | 1B |
| Paginação e dados desatualizados | `queries.test.mjs`: total integral, novas leituras e cache somente com período/escopo iguais | 1B |
| Categorização confirmada e desfazer | Journal, precondições, patch de campo único e recuperação | 1C |
| Relatório diário e alertas | `scheduler.test.mjs`, `reports.test.mjs`, `alerts-domain.test.mjs`: ativação explícita, DST, recuperação, atomicidade, reavaliação e transições com histerese | 1D |
| Agendas Actual observadas sem execução automática | `actual-schedules.test.mjs`, `sdk-schedules.test.mjs`, `sdk-safety.test.mjs`: catálogo, metadata, guarda de autopost e reload | 2 |
| Unidades e candidatos de três meses | `recurrence-domain.test.mjs`, `bills.test.mjs`: IDs/unidades isolados, pendências, versões históricas e hipótese inativa | 2 |
| Competência, vencimento e calendário | `recurrence-domain.test.mjs`, `bills.test.mjs`: offset 0/1, dia 31/ano bissexto, estimativa, versões e overrides | 2 |
| Compatibilidade sem inferir quitação | `recurrence-domain.test.mjs`, `bills.test.mjs`: concorrentes, cobertura, fingerprints, revogação e pagamento manual separado | 2 |
| Propostas locais e migração | `bills.test.mjs`: identidade/política/prazo/replay, atomicidade, recuperação e upgrade 003→004 com dados anteriores | 2 |
| Lembretes offline e variação | `bills.test.mjs`: opt-in, DST/restart, cancelamento/429, limites AND, histerese e fonte atual | 2 |
| Aceite pelo fluxo público Telegram | `mvp-bills-acceptance.test.mjs`: ingresso, handler, jobs/outbox e SQLite em disco; unidade/conta confirmadas, Actual/LLM indisponíveis, aviso sem duplicar e pago/reabrir confirmados | 2 |
| Monitor de novos gastos | `transaction-monitor.test.mjs`: baseline silencioso, elegibilidade, limites/dedupe, alta confiança, perguntas, resolução externa e escrita auditada sem reaprender o próprio resultado | 3B |

Gemini é opcional e desativado por padrão; seu uso depende de configuração no servidor e confirmação de contexto no Telegram, sem fallback remoto. A conversa pode ler ferramentas fechadas e preparar categoria/lote confirmado; não chama métodos arbitrários nem confirma propostas. E-mail, cofre, portais e execução de pagamentos/transferências permanecem fora do escopo. A única escrita sem confirmação individual é a categorização 3B opcional, limitada à política de alta confiança documentada em [autorização](authorization.md). [Arquitetura e critérios de conversa](conversation.md).

| Extensão | Prova local |
| --- | --- |
| Provedores sem SDK extra, tool calls e limites | `chat-providers.test.mjs`: HTTP simulado, assinaturas/IDs, bloqueio remoto, contexto, corpo, prazo e canários |
| Configuração somente de IA | `setup-ai.test.mjs`: preservação de Actual/Telegram/backup/override, entrada oculta, cancelamento e rollback; Bash validado no Linux |
| Sessão, consentimento e propostas | `conversation.test.mjs`, `assistant-tools.test.mjs`, `actual-category-create.test.mjs` e `sdk-category-create.test.mjs`; limites e cenários estão em [conversation.md](conversation.md#propostas-e-critérios-de-aceite) |

## Consultas e categorização

`/gastos` separa despesas brutas, estornos identificados e líquido. Entrada positiva em categoria de despesa é a regra de identificação de estorno; não é investigação documental. Receita categorizada não prova recorrência. `/ralos` oferece classificação descritiva por despesa líquida; não declara desperdício, fraude ou plano de economia garantido.

O orçamento mensal é o envelope integral retornado pelo Actual e pode incluir transações posteriores à data final da consulta. A preferência de contas só altera os cálculos de transações, não esses fatos mensais. Diferença entre saldo antes do consumo e alocado é uma derivação; o campo `carryover` do SDK é booleano.

A preferência `/escopo` é uma atribuição local idempotente. No marco 1C, a categorização usa proposta persistida e confirmação explícita por comando ou callback; desfazer exige uma nova proposta. A execução real depende de `dryRun:false` e backups cifrados; o padrão simula a operação. Pais e filhos de split aparecem nas consultas e são bloqueados para escrita por limitação de preservação dos campos no SDK fixado. Detalhes de autorização e recuperação estão em [authorization.md](authorization.md) e [actual-contract.md](actual-contract.md).

Os testes locais não substituem validação da imagem Linux/UID de produção, compatibilidade com o servidor Actual e demonstração controlada com o bot do responsável.

## Relatórios e alertas financeiros

`/relatorio` é uma consulta imediata. Diário e alertas periódicos só começam após ativação separada em `/preferencias`; nenhum modelo é necessário. A agenda considera o horário civil escolhido e mantém uma ocorrência por data civil; o relatório preserva a data financeira do instante agendado. O reinício recupera somente a última ocorrência devida de cada rotina. [Políticas de horário, cancelamento e persistência](scheduling.md).

Anomalias são desvios estatísticos descritivos com ao menos oito observações comparáveis anteriores. Novos alvos usam os últimos 30 dias; a base e os alvos acompanhados usam a leitura de 12 meses. Ausência fora dessa cobertura, dado desconhecido, snapshot incompleto e Actual indisponível não comprovam resolução. Alertas dependem de transições persistidas e têm limite de 20 novos avisos por varredura; os excedentes continuam elegíveis para a próxima leitura. [Fórmulas e limites](reporting.md).

## Recorrências e limites do MVP

Cadastros mensais e unidades usam propostas de uso único. Confirmações persistem localmente mesmo em `dryRun`; o modo continua protegendo a escrita de categoria no Actual. Competência não é data de lançamento ou vencimento: dia, offset 0/1 e classificação estimada/confirmada são escolhas explícitas. O calendário aplica último dia do mês quando necessário e não ajusta feriados. Fonte Actual é observação; regras semanais/anuais, `endN` e fim de semana não são copiadas para a regra mensal. [Guia de recorrências](recurrences.md).

Três meses consecutivos podem formar candidato, sem ativação automática. Unidade é resolvida por atribuição explícita ou mapeamento inequívoco de IDs; históricos conflitantes permanecem pendentes. Matching usa janela ±7 dias e cobertura completa, com todos os concorrentes materializados. Compatibilidade, `cleared` e vínculo de agenda nunca comprovam pagamento. `/pago` e `/reabrir` exigem novas confirmações; documento permanece não verificado.

Lembretes conhecidos usam somente o calendário local e continuam com Actual/modelo indisponíveis. Cada cadastro começa com lembretes e variação desligados. Variação exige leitura fresca, referência conhecida e diferença estritamente maior que ambos os limites (padrões 20% e 2000 centavos); estados persistidos e histerese evitam repetição do mesmo episódio. Entrega Telegram incerta não é reenviada automaticamente.

Os testes usam relógio controlado e dados sintéticos; não constituem demonstração de mensagens no bot real, conexão ao servidor pessoal, pagamento ou recebimento documental. Dados reais e implantação pessoal precisam das verificações do [runbook](runbook.md). E-mail, cofre, portais, expansão geral de agendas SDK e execução bancária não fazem parte do MVP.
