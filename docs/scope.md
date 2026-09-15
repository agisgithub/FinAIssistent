# Escopo e aceite

Projeto novo. Baseline: Node.js 24, ESM, `@actual-app/api` 26.9.0 e `better-sqlite3` 12.11.1. Um responsável, uma residência, um orçamento e BRL.

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
| Relatório diário e alertas | Agenda persistente, ocorrência única e mudanças de severidade | 1D |
| Recorrências confirmadas | Calendário, variações e pagamento vinculado | 2 |

Gemini é uma fase opcional separada. E-mail, cofre, portais e automação sem confirmação são posteriores. O executor inicial não aceita pagamentos, transferências, exportação pelo chat nem métodos arbitrários.

## Limites do marco 1B

`/gastos` separa despesas brutas, estornos identificados e líquido. Entrada positiva em categoria de despesa é a regra de identificação de estorno; não é investigação documental. Receita categorizada não prova recorrência. `/ralos` oferece classificação descritiva por despesa líquida; não declara desperdício, fraude ou plano de economia garantido.

O orçamento mensal é o envelope integral retornado pelo Actual e pode incluir transações posteriores à data final da consulta. A preferência de contas só altera os cálculos de transações, não esses fatos mensais. Diferença entre saldo antes do consumo e alocado é uma derivação; o campo `carryover` do SDK é booleano.

A preferência `/escopo` é uma atribuição local idempotente. No marco 1C, a categorização usa proposta persistida e confirmação explícita por comando ou callback; desfazer exige uma nova proposta. A execução real depende de `dryRun:false` e backups cifrados; o padrão simula a operação. Pais e filhos de split aparecem nas consultas e são bloqueados para escrita por limitação de preservação dos campos no SDK fixado. Detalhes de autorização e recuperação estão em [authorization.md](authorization.md) e [actual-contract.md](actual-contract.md).

Os testes locais não substituem validação da imagem Linux/UID de produção, compatibilidade com o servidor Actual e demonstração controlada com o bot do responsável.
